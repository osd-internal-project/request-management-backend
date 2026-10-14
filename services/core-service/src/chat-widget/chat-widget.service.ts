import { Injectable } from '@nestjs/common';
import {
  AuditWriter,
  auditActor,
  PrismaTransactionService,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import { widgetOrigin } from './chat-widget-rules';
import { SaveChatWidgetSettingsDto } from './chat-widget.dto';
import { ChatWidgetSettingRepository } from './chat-widget.repository';

interface WidgetRow {
  httpUrl: string | null;
  httpsUrl: string | null;
  publicId: string | null;
  updatedAt: Date;
}

function toRuntime(row: WidgetRow | null) {
  return {
    http_url: row?.httpUrl ?? null,
    https_url: row?.httpsUrl ?? null,
    public_id: row?.publicId ?? null,
  };
}

@Injectable()
export class ChatWidgetService {
  constructor(
    private readonly settings: ChatWidgetSettingRepository,
    private readonly transactions: PrismaTransactionService,
    private readonly audit: AuditWriter,
  ) {}

  /** What the ผู้ช่วย AI panel loads; nulls mean the frontend uses its env. */
  async runtime(actor: Principal) {
    return toRuntime(await this.find(actor.activeCompanyId));
  }

  async view(actor: Principal) {
    const row = await this.find(actor.activeCompanyId);
    return { ...toRuntime(row), updated_at: row?.updatedAt ?? null };
  }

  async save(actor: Principal, dto: SaveChatWidgetSettingsDto) {
    const companyId = actor.activeCompanyId;
    const data = {
      httpUrl: widgetOrigin(dto.http_url, 'http:'),
      httpsUrl: widgetOrigin(dto.https_url, 'https:'),
      publicId: dto.public_id?.trim() || null,
    };
    const before = await this.runtime(actor);
    await this.transactions.execute(async (prisma) => {
      await this.settings.upsert(
        {
          where: { companyId },
          create: { companyId, ...data, updatedBy: actor.userId },
          update: { ...data, updatedBy: actor.userId },
        },
        { prisma },
      );
      await this.audit.record(
        {
          eventType: 'chat_widget.settings.updated',
          companyId,
          ...auditActor(actor),
          resourceType: 'chat_widget_setting',
          resourceId: companyId,
          before: {
            httpUrl: before.http_url,
            httpsUrl: before.https_url,
            publicId: before.public_id,
          },
          after: data,
        },
        { prisma },
      );
    });
    return this.view(actor);
  }

  private async find(companyId: string) {
    return (await this.settings.findFirst({
      where: { companyId },
    })) as WidgetRow | null;
  }
}
