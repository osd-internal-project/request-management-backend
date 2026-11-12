import type { SecretKeyring } from '@request-management/share';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AppError,
  AuditWriter,
  auditActor,
  type Principal,
} from '@request-management/share';
import { sealSecret } from '../pm/config-rules';
import {
  MailClientsService,
  type MailSettingRow,
} from './mail-clients.service';
import { MailSettingRepository } from './mail-setting.repository';
import { textToHtml } from './mail-rules';
import type {
  TestMailSettingsDto,
  UpdateMailSettingsDto,
} from './dto/mail-settings.dto';

interface StoredSetting extends MailSettingRow {
  lastTestAt: Date | null;
  lastTestOk: boolean | null;
  lastTestError: string | null;
  updatedAt: Date;
  updatedBy: string;
}

/**
 * ตั้งค่าอีเมลงานขาย (5 พ.ย. 2569, ผู้ใช้เลือก) — the company's mailbox and
 * Microsoft Graph app, set on screen instead of env. The secret is sealed
 * with CONFIG_SECRET_KEY and never returned; leaving it blank keeps the one
 * saved. A company with no row keeps using `MAIL_*` from env.
 */
@Injectable()
export class MailSettingsService {
  constructor(
    private readonly settings: MailSettingRepository,
    private readonly clients: MailClientsService,
    private readonly config: ConfigService,
    private readonly audit: AuditWriter,
  ) {}

  async get(actor: Principal) {
    const row = (await this.settings.findFirst({
      where: { companyId: actor.activeCompanyId },
    })) as StoredSetting | null;
    const resolved = await this.clients.forCompany(actor.activeCompanyId);
    return {
      source: resolved.source,
      mode: resolved.mode,
      mailbox: row
        ? row.mailbox
        : (this.config.get<string>('mail.mailbox') ?? ''),
      sender_name: row?.senderName ?? '',
      tenant_id: row?.tenantId ?? '',
      client_id: row?.clientId ?? '',
      client_secret_set: !!row?.clientSecretEnc,
      problem: resolved.problem,
      last_test_at: row?.lastTestAt?.toISOString() ?? null,
      last_test_ok: row?.lastTestOk ?? null,
      last_test_error: row?.lastTestError ?? null,
      updated_at: row?.updatedAt.toISOString() ?? null,
    };
  }

  async update(dto: UpdateMailSettingsDto, actor: Principal) {
    const current = (await this.settings.findFirst({
      where: { companyId: actor.activeCompanyId },
    })) as StoredSetting | null;
    const next = this.merge(actor.activeCompanyId, dto, current);
    assertComplete(next);

    await this.settings.upsert({
      where: { companyId: actor.activeCompanyId },
      create: { ...next, updatedBy: actor.userId },
      update: {
        mode: next.mode,
        mailbox: next.mailbox,
        senderName: next.senderName,
        tenantId: next.tenantId,
        clientId: next.clientId,
        clientSecretEnc: next.clientSecretEnc,
        updatedBy: actor.userId,
      },
    });
    this.clients.forget(actor.activeCompanyId);
    await this.audit.record({
      eventType: 'admin.mail_settings.updated',
      companyId: actor.activeCompanyId,
      ...auditActor(actor),
      resourceType: 'mail_settings',
      resourceId: actor.activeCompanyId,
      // never the secret — only whether it changed
      ...(current
        ? { before: { mode: current.mode, mailbox: current.mailbox } }
        : {}),
      after: {
        mode: next.mode,
        mailbox: next.mailbox,
        tenantId: next.tenantId,
        clientId: next.clientId,
        secretChanged: !!dto.client_secret?.trim(),
      },
    });
    return this.get(actor);
  }

  /**
   * Sends one email with the settings given (or saved) — the token, the
   * mailbox's rights and the send all happen for real in graph mode.
   */
  async test(dto: TestMailSettingsDto, actor: Principal) {
    const current = (await this.settings.findFirst({
      where: { companyId: actor.activeCompanyId },
    })) as StoredSetting | null;
    const candidate = this.merge(actor.activeCompanyId, dto, current);
    assertComplete(candidate);
    const resolved = this.clients.clientFor(candidate);
    if (!resolved.client) {
      throw new AppError(
        'CRM_EMAIL_UNAVAILABLE',
        resolved.problem ?? 'โหมดปิดอยู่ — เลือกโหมดจำลองหรือส่งจริงก่อนทดสอบ',
        [{ field: 'mode', reason: candidate.mode }],
      );
    }
    const to = dto.to?.trim() || actor.email || candidate.mailbox;
    if (!to) {
      throw new AppError('VALIDATION_FAILED', 'ระบุผู้รับอีเมลทดสอบ', [
        { field: 'to', reason: 'required' },
      ]);
    }

    let error: string | null = null;
    try {
      await resolved.client.send({
        to: [to],
        subject: 'ทดสอบอีเมลงานขาย — Connect the Dot',
        html: textToHtml(
          `อีเมลนี้ส่งจาก ${resolved.client.mailbox} เพื่อทดสอบการตั้งค่า\n\nถ้าได้รับ แปลว่าระบบส่งอีเมลงานขายได้แล้ว`,
        ),
      });
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    }

    if (current) {
      await this.settings.update({
        where: { companyId: actor.activeCompanyId },
        data: {
          lastTestAt: new Date(),
          lastTestOk: error === null,
          lastTestError: error?.slice(0, 1000) ?? null,
        },
      });
    }
    await this.audit.record({
      eventType: 'admin.mail_settings.tested',
      companyId: actor.activeCompanyId,
      ...auditActor(actor),
      resourceType: 'mail_settings',
      resourceId: actor.activeCompanyId,
      after: { mode: candidate.mode, ok: error === null },
    });
    return {
      ok: error === null,
      mode: resolved.client.mode,
      mailbox: resolved.client.mailbox,
      to,
      error,
    };
  }

  /** The screen's values over the saved row; a blank secret keeps the saved one. */
  private merge(
    companyId: string,
    dto: UpdateMailSettingsDto,
    current: StoredSetting | null,
  ): MailSettingRow {
    const secret = dto.client_secret?.trim();
    return {
      companyId,
      mode: dto.mode,
      mailbox: (dto.mailbox ?? current?.mailbox ?? '').trim(),
      senderName: (dto.sender_name ?? current?.senderName ?? '').trim(),
      tenantId: (dto.tenant_id ?? current?.tenantId ?? '').trim(),
      clientId: (dto.client_id ?? current?.clientId ?? '').trim(),
      clientSecretEnc: secret
        ? this.seal(secret)
        : (current?.clientSecretEnc ?? null),
    };
  }

  private seal(value: string): string {
    const secret = this.config.get<SecretKeyring>('projectConfig.secret');
    if (!secret) throw new Error('CONFIG_SECRET_KEY is not set');
    return sealSecret(value, secret);
  }
}

/** Graph needs all four; the screen names what is missing. */
function assertComplete(row: MailSettingRow): void {
  if (row.mode !== 'graph') return;
  const missing = [
    ['mailbox', row.mailbox],
    ['tenant_id', row.tenantId],
    ['client_id', row.clientId],
    ['client_secret', row.clientSecretEnc ?? ''],
  ].filter(([, value]) => !value);
  if (missing.length) {
    throw new AppError(
      'VALIDATION_FAILED',
      `ส่งจริงผ่าน Microsoft Graph ต้องกรอก ${missing.map(([field]) => field).join(', ')}`,
      missing.map(([field]) => ({ field, reason: 'required_for_graph' })),
    );
  }
}
