import { Injectable } from '@nestjs/common';
import type { ChatWidgetSetting } from '@prisma/client';
import {
  AppError,
  AuditWriter,
  auditActor,
  PrismaTransactionService,
} from '@request-management/share';
import type { Principal, TxOption } from '@request-management/share';
import { chooseDefault, widgetOrigin } from './chat-widget-rules';
import { SaveChatWidgetDto, SaveChatWidgetGroupDto } from './chat-widget.dto';
import { ChatWidgetSettingRepository } from './chat-widget.repository';

function toOption(row: ChatWidgetSetting) {
  return {
    id: row.id,
    name: row.name,
    http_url: row.httpUrl,
    https_url: row.httpsUrl,
    public_id: row.publicId,
  };
}

function toAdmin(row: ChatWidgetSetting & { _count?: { groups: number } }) {
  return {
    ...toOption(row),
    active: row.active,
    org_wide: row.orgWide,
    is_default: row.isDefault,
    sort_order: row.sortOrder,
    group_count: row._count?.groups ?? 0,
    updated_at: row.updatedAt,
  };
}

/** What the audit log keeps of a widget — no timestamps, no counts. */
function snapshot(row: ChatWidgetSetting) {
  return {
    name: row.name,
    httpUrl: row.httpUrl,
    httpsUrl: row.httpsUrl,
    publicId: row.publicId,
    active: row.active,
    orgWide: row.orgWide,
    isDefault: row.isDefault,
    sortOrder: row.sortOrder,
  };
}

/**
 * The LibreChat chats of a company. Org level: which chats exist, are active,
 * reach everyone, and which one is the org default. Group level: chats added
 * to an org unit (and its subtree) with that unit's own default.
 */
@Injectable()
export class ChatWidgetService {
  constructor(
    private readonly widgets: ChatWidgetSettingRepository,
    private readonly transactions: PrismaTransactionService,
    private readonly audit: AuditWriter,
  ) {}

  /** The chats this user may open and the one the panel starts on. */
  async runtime(actor: Principal) {
    const depthOf = await this.widgets.ancestorDepths(actor.orgUnitId);
    const visible = await this.widgets.findVisible(actor.activeCompanyId, [
      ...depthOf.keys(),
    ]);
    return {
      widgets: visible.map(toOption),
      default_id: chooseDefault(visible, depthOf),
    };
  }

  async list(actor: Principal) {
    const rows = await this.widgets.findForCompany(actor.activeCompanyId);
    return rows.map(toAdmin);
  }

  async create(actor: Principal, dto: SaveChatWidgetDto) {
    const companyId = actor.activeCompanyId;
    const data = this.validated(dto, null);
    const row = await this.transactions.execute(async (prisma) => {
      const created = await this.widgets.create(
        { data: { companyId, ...data, createdBy: actor.userId } },
        { prisma },
      );
      if (created.isDefault) {
        await this.widgets.clearOrgDefault(companyId, created.id, { prisma });
      }
      await this.record(
        actor,
        'chat_widget.created',
        created.id,
        null,
        created,
        { prisma },
      );
      return created;
    });
    return toAdmin(row);
  }

  async update(actor: Principal, id: string, dto: SaveChatWidgetDto) {
    const companyId = actor.activeCompanyId;
    const before = await this.require(companyId, id);
    const data = this.validated(dto, before);
    const row = await this.transactions.execute(async (prisma) => {
      const updated = await this.widgets.update(
        { where: { id }, data: { ...data, updatedBy: actor.userId } },
        { prisma },
      );
      if (updated.isDefault) {
        await this.widgets.clearOrgDefault(companyId, id, { prisma });
      }
      await this.record(actor, 'chat_widget.updated', id, before, updated, {
        prisma,
      });
      return updated;
    });
    return toAdmin(row);
  }

  async remove(actor: Principal, id: string) {
    const before = await this.require(actor.activeCompanyId, id);
    await this.transactions.execute(async (prisma) => {
      await this.widgets.delete({ where: { id } }, { prisma });
      await this.record(actor, 'chat_widget.deleted', id, before, null, {
        prisma,
      });
    });
  }

  async orgUnits(actor: Principal) {
    const units = await this.widgets.companyUnits(actor.activeCompanyId);
    return units.map(({ _count, ...unit }) => ({
      ...unit,
      chat_count: _count.chatWidgets,
    }));
  }

  async group(actor: Principal, orgUnitId: string) {
    await this.requireUnit(actor.activeCompanyId, orgUnitId);
    return this.groupView(orgUnitId);
  }

  async saveGroup(
    actor: Principal,
    orgUnitId: string,
    dto: SaveChatWidgetGroupDto,
  ) {
    const companyId = actor.activeCompanyId;
    await this.requireUnit(companyId, orgUnitId);
    const widgetIds = [...new Set(dto.widget_ids)];
    const defaultId = dto.default_id || null;
    if (defaultId && !widgetIds.includes(defaultId)) {
      throw new AppError(
        'VALIDATION_FAILED',
        'default ของ group ต้องเป็น chat ที่ add ให้ group นี้',
      );
    }
    const active = await this.widgets.findMany({
      where: { companyId, active: true, id: { in: widgetIds } },
      select: { id: true },
    });
    if (active.length !== widgetIds.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        'add ได้เฉพาะ chat ที่ active ของบริษัทนี้',
      );
    }
    const before = await this.groupView(orgUnitId);
    await this.transactions.execute(async (prisma) => {
      await this.widgets.replaceGroup(orgUnitId, widgetIds, defaultId, {
        prisma,
      });
      await this.audit.record(
        {
          eventType: 'chat_widget.group.updated',
          companyId,
          ...auditActor(actor),
          resourceType: 'org_unit',
          resourceId: orgUnitId,
          before,
          after: { widget_ids: widgetIds, default_id: defaultId },
        },
        { prisma },
      );
    });
    return this.groupView(orgUnitId);
  }

  private async groupView(orgUnitId: string) {
    const rows = await this.widgets.activeGroupRows(orgUnitId);
    return {
      widget_ids: rows.map((row) => row.widgetId),
      default_id: rows.find((row) => row.isDefault)?.widgetId ?? null,
    };
  }

  /** The DTO as columns, with every rule a widget must keep. */
  private validated(dto: SaveChatWidgetDto, before: ChatWidgetSetting | null) {
    const name = dto.name.trim();
    const publicId = dto.public_id.trim();
    if (!name || !publicId) {
      throw new AppError('VALIDATION_FAILED', 'ต้องระบุชื่อและ public id');
    }
    const httpUrl = widgetOrigin(dto.http_url, 'http:');
    const httpsUrl = widgetOrigin(dto.https_url, 'https:');
    if (!httpUrl && !httpsUrl) {
      throw new AppError(
        'VALIDATION_FAILED',
        'ต้องมีที่อยู่ LibreChat อย่างน้อยหนึ่งช่อง (http หรือ https)',
      );
    }
    const active = dto.active ?? before?.active ?? true;
    const orgWide = dto.org_wide ?? before?.orgWide ?? true;
    const isDefault = dto.is_default ?? before?.isDefault ?? false;
    if (isDefault && (!active || !orgWide)) {
      throw new AppError(
        'VALIDATION_FAILED',
        'default ของ org ต้อง active และเห็นทั้งองค์กร — ตั้ง default ตัวอื่นก่อน',
      );
    }
    return {
      name,
      httpUrl,
      httpsUrl,
      publicId,
      active,
      orgWide,
      isDefault,
      sortOrder: dto.sort_order ?? before?.sortOrder ?? 0,
    };
  }

  /** Another company's widget answers 404, not 403 (SCOPE-03). */
  private async require(companyId: string, id: string) {
    const row = await this.widgets.findFirst({ where: { id, companyId } });
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบ chat นี้');
    return row;
  }

  private async requireUnit(companyId: string, orgUnitId: string) {
    const unit = await this.widgets.findUnit(companyId, orgUnitId);
    if (!unit) throw new AppError('NOT_FOUND', 'ไม่พบหน่วยงานนี้');
    return unit;
  }

  private record(
    actor: Principal,
    eventType: string,
    id: string,
    before: ChatWidgetSetting | null,
    after: ChatWidgetSetting | null,
    option: TxOption,
  ) {
    return this.audit.record(
      {
        eventType,
        companyId: actor.activeCompanyId,
        ...auditActor(actor),
        resourceType: 'chat_widget',
        resourceId: id,
        before: before ? snapshot(before) : undefined,
        after: after ? snapshot(after) : undefined,
      },
      option,
    );
  }
}
