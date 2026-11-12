import type { SecretKeyring } from '@request-management/share';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { SoftphoneExtension } from '@prisma/client';
import {
  AppError,
  AuditWriter,
  auditActor,
  PrismaTransactionService,
} from '@request-management/share';
import type { Principal, TxOption } from '@request-management/share';
import { CareContactLookupRepository } from '../care/care.repositories';
import { phoneKey } from '../care/care-rules';
import { openSecret, sealSecret } from '../pm/config-rules';
import { RequestRepository } from '../requests/request.repository';
import { RequestsService } from '../requests/requests.service';
import { callSeconds, sipSettings } from './softphone-rules';
import { CreateCallLogDto, SaveSoftphoneExtensionDto } from './softphone.dto';
import {
  CALL_LOG_TYPE,
  SoftphoneExtensionRepository,
} from './softphone.repository';

/** What the audit log keeps of an extension — never the password. */
function snapshot(row: SoftphoneExtension) {
  return {
    userId: row.userId,
    extension: row.extension,
    wssUrl: row.wssUrl,
    sipServer: row.sipServer,
    active: row.active,
  };
}

/**
 * The softphone: each user's SIP line (set by an admin, password sealed) and
 * the call log written after an answered inbound call is hung up.
 */
@Injectable()
export class SoftphoneService {
  private readonly logger = new Logger(SoftphoneService.name);

  constructor(
    private readonly extensions: SoftphoneExtensionRepository,
    private readonly requests: RequestsService,
    private readonly requestRows: RequestRepository,
    private readonly contacts: CareContactLookupRepository,
    private readonly transactions: PrismaTransactionService,
    private readonly audit: AuditWriter,
    private readonly config: ConfigService,
  ) {}

  /**
   * The caller's own line in the active company. The one place the password
   * leaves the database: SIP.js registers from the browser and needs it.
   */
  async runtime(actor: Principal) {
    const row = await this.extensions.findFirst({
      where: {
        companyId: actor.activeCompanyId,
        userId: actor.userId,
        active: true,
      },
    });
    if (!row) return { enabled: false as const };
    const password = openSecret(row.passwordSealed, this.sealKey());
    if (password === null) {
      this.logger.warn(`softphone extension ${row.id}: password unreadable`);
      return { enabled: false as const, reason: 'PASSWORD_UNREADABLE' };
    }
    return {
      enabled: true as const,
      extension: row.extension,
      password,
      wss_url: row.wssUrl,
      sip_server: row.sipServer,
    };
  }

  async list(actor: Principal) {
    const rows = await this.extensions.findForCompany(actor.activeCompanyId);
    const users = await this.extensions.usersByIds(rows.map((r) => r.userId));
    const byId = new Map(users.map((user) => [user.id, user]));
    return rows.map((row) => this.toAdmin(row, byId.get(row.userId)));
  }

  async create(actor: Principal, dto: SaveSoftphoneExtensionDto) {
    const companyId = actor.activeCompanyId;
    const password = dto.password?.trim();
    if (!password) {
      throw new AppError('VALIDATION_FAILED', 'ต้องระบุรหัส SIP');
    }
    await this.requireMember(companyId, dto.user_id);
    const taken = await this.extensions.findFirst({
      where: { companyId, userId: dto.user_id },
    });
    if (taken) {
      throw new AppError(
        'VALIDATION_FAILED',
        'ผู้ใช้นี้มีเลขต่อในบริษัทนี้แล้ว — แก้รายการเดิมแทน',
      );
    }
    const row = await this.transactions.execute(async (prisma) => {
      const created = await this.extensions.create(
        {
          data: {
            companyId,
            userId: dto.user_id,
            ...sipSettings(dto),
            passwordSealed: sealSecret(password, this.sealKey()),
            active: dto.active ?? true,
            createdBy: actor.userId,
          },
        },
        { prisma },
      );
      await this.record(actor, 'softphone.extension.created', created.id, {
        before: null,
        after: created,
        option: { prisma },
      });
      return created;
    });
    return this.toAdmin(row);
  }

  async update(actor: Principal, id: string, dto: SaveSoftphoneExtensionDto) {
    const companyId = actor.activeCompanyId;
    const before = await this.require(companyId, id);
    if (dto.user_id !== before.userId) {
      throw new AppError(
        'VALIDATION_FAILED',
        'เปลี่ยนผู้ใช้ของเลขต่อไม่ได้ — ลบแล้วเพิ่มใหม่',
      );
    }
    const password = dto.password?.trim();
    const row = await this.transactions.execute(async (prisma) => {
      const updated = await this.extensions.update(
        {
          where: { id },
          data: {
            ...sipSettings(dto),
            ...(password
              ? { passwordSealed: sealSecret(password, this.sealKey()) }
              : {}),
            active: dto.active ?? before.active,
            updatedBy: actor.userId,
          },
        },
        { prisma },
      );
      await this.record(actor, 'softphone.extension.updated', id, {
        before,
        after: updated,
        option: { prisma },
      });
      return updated;
    });
    return this.toAdmin(row);
  }

  async remove(actor: Principal, id: string) {
    const before = await this.require(actor.activeCompanyId, id);
    await this.transactions.execute(async (prisma) => {
      await this.extensions.delete({ where: { id } }, { prisma });
      await this.record(actor, 'softphone.extension.deleted', id, {
        before,
        after: null,
        option: { prisma },
      });
    });
  }

  /**
   * One `CALL_LOG` draft per answered call, the agent as requester. A second
   * report of the same call (the softphone fires hang-up more than once)
   * returns the first request instead of writing another.
   */
  async logCall(actor: Principal, dto: CreateCallLogDto) {
    const companyId = actor.activeCompanyId;
    const existing = await this.extensions.findCallLog(companyId, dto.call_id);
    if (existing) return { id: existing.id, created: false };

    if (!(await this.extensions.callLogTypeEnabled(companyId))) {
      throw new AppError(
        'NOT_FOUND',
        'บริษัทนี้ยังไม่เปิดประเภทคำขอ CALL_LOG — ให้ผู้ดูแลเปิดในหน้าประเภทคำขอ',
      );
    }
    const answeredAt = new Date(dto.answered_at);
    const endedAt = new Date(dto.ended_at);
    const durationSec = callSeconds(answeredAt, endedAt);
    const phone = dto.phone.trim();
    const key = phoneKey(phone);
    const [contact] = key
      ? await this.contacts.byField(companyId, 'phone', [key])
      : [];

    const created = await this.requests.create(
      {
        type_code: CALL_LOG_TYPE,
        form_data: {
          call_id: dto.call_id,
          phone,
          contact_name: contact?.name ?? '',
          answered_at: answeredAt.toISOString(),
          ended_at: endedAt.toISOString(),
          duration_sec: durationSec,
        },
        ...(contact
          ? { ref_type: 'customer', ref_id: contact.customerId }
          : {}),
      },
      actor,
    );
    await this.transactions.execute(async (prisma) => {
      await this.requestRows.update(
        {
          where: { id: created.id },
          data: {
            channel: 'phone',
            contactPhone: phone,
            contactName: contact?.name ?? null,
          },
        },
        { prisma },
      );
      await this.audit.record(
        {
          eventType: 'softphone.call_logged',
          companyId,
          ...auditActor(actor),
          resourceType: 'request',
          resourceId: created.id,
          after: { callId: dto.call_id, durationSec, contactId: contact?.id },
        },
        { prisma },
      );
    });
    return { id: created.id, created: true };
  }

  private toAdmin(
    row: SoftphoneExtension,
    user?: { username: string; displayName: string },
  ) {
    return {
      id: row.id,
      user_id: row.userId,
      user_name: user?.displayName ?? null,
      username: user?.username ?? null,
      extension: row.extension,
      wss_url: row.wssUrl,
      sip_server: row.sipServer,
      active: row.active,
      has_password: row.passwordSealed.length > 0,
      updated_at: row.updatedAt,
    };
  }

  private async require(companyId: string, id: string) {
    const row = await this.extensions.findFirst({ where: { id, companyId } });
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบเลขต่อนี้');
    return row;
  }

  private async requireMember(companyId: string, userId: string) {
    if (!(await this.extensions.isMember(companyId, userId))) {
      throw new AppError('NOT_FOUND', 'ไม่พบผู้ใช้นี้ในบริษัท');
    }
  }

  private record(
    actor: Principal,
    eventType: string,
    id: string,
    change: {
      before: SoftphoneExtension | null;
      after: SoftphoneExtension | null;
      option: TxOption;
    },
  ) {
    return this.audit.record(
      {
        eventType,
        companyId: actor.activeCompanyId,
        ...auditActor(actor),
        resourceType: 'softphone_extension',
        resourceId: id,
        before: change.before ? snapshot(change.before) : undefined,
        after: change.after ? snapshot(change.after) : undefined,
      },
      change.option,
    );
  }

  private sealKey(): SecretKeyring {
    const key = this.config.get<SecretKeyring>('projectConfig.secret');
    if (!key) throw new Error('CONFIG_SECRET_KEY is not set');
    return key;
  }
}
