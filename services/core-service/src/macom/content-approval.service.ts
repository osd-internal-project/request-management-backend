import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  AppError,
  AuditWriter,
  auditActor,
  PrismaTransactionService,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import { CrmConfigRepository } from '../crm/segment.repositories';
import { DomainEventsService } from '../events/domain-events.service';
import {
  DOMAIN_EVENTS,
  type DomainEventName,
  type RequestEventPayload,
} from '../events/event-catalog';
import { NotificationsService } from '../notifications/notifications.service';
import { RequestsService } from '../requests/requests.service';
import { needsApproval } from './content-rules';
import { ContentService, type ContentRow } from './content.service';
import {
  ContentFileRepository,
  ContentItemRepository,
} from './macom.repositories';

type Outcome = 'approved' | 'rejected' | 'cancelled';

const CHANNEL_NAMES: Record<string, string> = {
  line_oa: 'LINE OA',
  facebook: 'Facebook',
  tiktok: 'TikTok',
  instagram: 'Instagram',
  website: 'เว็บไซต์',
  email: 'อีเมล',
};

/**
 * CD-272 — content that goes out to the public is approved on the central
 * approval engine (user decisions 6 Oct 2026):
 *
 * - which: content the author flags as naming a customer, a price or a
 *   partner — or all content when the company says so
 *   (`CrmConfig.contentApprovalAll`); unflagged content goes Draft → Ready;
 * - how: "send for approval" raises **and submits** a request of the type set
 *   in CRM settings (`contentApprovalTypeCode`), with the words, channel,
 *   time, flags and media names; the ladder is that type's, editable on A1;
 * - the approval is for that version: approved → Ready; any later change to
 *   the words, channel or campaign is a new version and drops it to Draft;
 *   rejected or withdrawn → Draft, with the reason kept.
 *
 * Matched by `ContentItem.approvalRequestId`, never by type code.
 */
@Injectable()
export class ContentApprovalService implements OnModuleInit {
  private readonly logger = new Logger(ContentApprovalService.name);

  constructor(
    private readonly content: ContentService,
    private readonly items: ContentItemRepository,
    private readonly files: ContentFileRepository,
    private readonly requests: RequestsService,
    private readonly configs: CrmConfigRepository,
    private readonly events: DomainEventsService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  onModuleInit(): void {
    const outcomes: [DomainEventName, Outcome][] = [
      [DOMAIN_EVENTS.requestApproved, 'approved'],
      [DOMAIN_EVENTS.requestRejected, 'rejected'],
      [DOMAIN_EVENTS.requestCancelled, 'cancelled'],
    ];
    for (const [name, outcome] of outcomes) {
      this.events.on(name, (event) =>
        this.onRequestOutcome(event.payload as RequestEventPayload, outcome),
      );
    }
  }

  /** The company's approval settings. */
  async settings(companyId: string) {
    const config = (await this.configs.findFirst({
      where: { companyId },
      select: { contentApprovalTypeCode: true, contentApprovalAll: true },
    })) as {
      contentApprovalTypeCode: string | null;
      contentApprovalAll: boolean;
    } | null;
    return {
      typeCode: config?.contentApprovalTypeCode ?? null,
      all: config?.contentApprovalAll ?? false,
    };
  }

  async send(actor: Principal, id: string) {
    const item = await this.content.require(actor, id);
    if (item.status !== 'draft') {
      throw new AppError('CONFLICT', 'ส่งอนุมัติได้เฉพาะคอนเทนต์ที่เป็นร่าง');
    }
    const settings = await this.settings(item.companyId);
    if (!settings.typeCode) {
      throw new AppError(
        'CONFLICT',
        'ยังไม่ได้ตั้งประเภทคำขอ "อนุมัติคอนเทนต์" ในตั้งค่า CRM',
      );
    }
    if (!needsApproval(item, settings.all)) {
      throw new AppError(
        'CONFLICT',
        'คอนเทนต์นี้ไม่ต้องอนุมัติ — ตั้งเป็นพร้อมเผยแพร่ได้เลย',
      );
    }
    const media = (await this.files.findMany({
      where: { contentId: id, removedAt: null },
      select: { fileName: true },
    })) as { fileName: string }[];

    const created = (await this.requests.create(
      {
        type_code: settings.typeCode,
        form_data: {
          subject: `อนุมัติคอนเทนต์: ${item.title}`,
          content_title: item.title,
          channel: CHANNEL_NAMES[item.channel] ?? item.channel,
          planned_at: item.plannedAt.toISOString(),
          caption: item.caption,
          mentions: [
            item.mentionsCustomer && 'ลูกค้า',
            item.mentionsPrice && 'ราคา',
            item.mentionsPartner && 'คู่ค้า',
          ]
            .filter(Boolean)
            .join(', '),
          media: media.map((file) => file.fileName).join('\n'),
          content_version: String(item.version),
          content_id: item.id,
        },
      },
      actor,
    )) as { id: string; requestNo: string | null };
    try {
      await this.requests.submit(created.id, actor, '');
    } catch (error) {
      // not left as a stray draft under the author
      await this.requests
        .cancel(
          created.id,
          {
            reason: `ส่งอนุมัติไม่สำเร็จ: ${error instanceof Error ? error.message : 'ไม่ทราบสาเหตุ'}`,
          },
          actor,
        )
        .catch(() => undefined);
      throw error;
    }

    await this.transactions.execute(async (prisma) => {
      const moved = await this.items.updateMany(
        {
          where: { id, status: 'draft' },
          data: {
            status: 'pending_approval',
            approvalStatus: 'pending',
            approvalRequestId: created.id,
            approvalNote: null,
            updatedBy: actor.userId,
          },
        },
        { prisma },
      );
      if (moved.count !== 1) {
        throw new AppError('CONFLICT', 'คอนเทนต์นี้เปลี่ยนสถานะไปแล้ว');
      }
      await this.audit.record(
        {
          eventType: 'macom.content.approval_requested',
          companyId: item.companyId,
          ...auditActor(actor),
          resourceType: 'content_item',
          resourceId: id,
          after: {
            requestId: created.id,
            requestNo: created.requestNo,
            version: item.version,
          },
        },
        { prisma },
      );
    });
    return this.content.one(actor, id);
  }

  /** Take it back while it waits — cancels the request; the event moves it to Draft. */
  async withdraw(actor: Principal, id: string, reason: string) {
    const item = await this.content.require(actor, id);
    if (item.status !== 'pending_approval' || !item.approvalRequestId) {
      throw new AppError('CONFLICT', 'คอนเทนต์นี้ไม่ได้รออนุมัติอยู่');
    }
    await this.requests.cancel(
      item.approvalRequestId,
      { reason: reason.trim() || 'ถอนคอนเทนต์ออกมาแก้' },
      actor,
    );
    // the event handler normally gets here first; make sure it is settled
    await this.onRequestOutcome(
      {
        request_id: item.approvalRequestId,
        request_no: null,
      } as RequestEventPayload,
      'cancelled',
      reason,
    );
    return this.content.one(actor, id);
  }

  async onRequestOutcome(
    payload: RequestEventPayload,
    outcome: Outcome,
    note?: string,
  ): Promise<void> {
    const item = (await this.items.findFirst({
      where: {
        approvalRequestId: payload.request_id,
        status: 'pending_approval',
      },
    })) as (ContentRow & { approvalRequestId: string }) | null;
    // Not ours, redelivered, or already settled.
    if (!item) return;

    // the approver's words live on the request; point there
    const reason =
      note?.trim() ||
      (outcome === 'rejected'
        ? `ไม่อนุมัติ — ดูเหตุผลในคำขอ ${payload.request_no ?? ''}`.trim()
        : null);
    const moved = await this.transactions.execute(async (prisma) => {
      const result = await this.items.updateMany(
        {
          where: {
            id: item.id,
            approvalRequestId: payload.request_id,
            status: 'pending_approval',
          },
          data: {
            status: outcome === 'approved' ? 'ready' : 'draft',
            approvalStatus: outcome,
            ...(outcome === 'approved'
              ? { approvedVersion: item.version, approvalNote: null }
              : { approvalNote: reason }),
          },
        },
        { prisma },
      );
      if (result.count !== 1) return false;
      await this.audit.record(
        {
          eventType: `macom.content.approval_${outcome}`,
          companyId: item.companyId,
          actorId: null,
          actorUsername: 'content-approval-sync',
          resourceType: 'content_item',
          resourceId: item.id,
          before: { status: 'pending_approval' },
          after: {
            status: outcome === 'approved' ? 'ready' : 'draft',
            requestId: payload.request_id,
            version: item.version,
            reason,
          },
        },
        { prisma },
      );
      return true;
    });
    if (!moved || outcome === 'cancelled') return;
    await this.notifications
      .contentApproval(item.ownerUserId, item.companyId, {
        kind: outcome,
        contentId: item.id,
        title: item.title,
        reason: reason ?? '',
      })
      .catch((error: unknown) =>
        this.logger.warn(`content approval notice failed: ${String(error)}`),
      );
  }
}
