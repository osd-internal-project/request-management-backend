import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppError, AuditWriter } from '@request-management/share';
import { RequestIntakeChannelRepository } from '../crm/customer-intake.repository';
import { CrmConfigRepository } from '../crm/segment.repositories';
import { LlmService } from '../llm/llm.service';
import { RequestsService } from '../requests/requests.service';
import { PmPlanService } from '../support/pm-plan.service';
import { ServiceAssetRepository } from '../support/support.repositories';
import { WorkOrdersService } from '../support/work-orders.service';
import {
  DEFAULT_SEVERITY_WORDS,
  caseDetail,
  caseNotice,
  caseSubject,
  severityOf,
  wordsFrom,
  type Severity,
} from './care-case-rules';
import {
  CareContactLookupRepository,
  CareConversationRepository,
  CareMessageRepository,
} from './care.repositories';
import type { ConversationRow } from './care.service';

export interface CareCase {
  requestId: string;
  requestNo: string | null;
  severity: Severity;
  /** The customer's link to follow the case (CD-66 status page). */
  statusLink: string | null;
  /** A service job (verified sender) — else a case for the team to tie to a customer. */
  workOrder: boolean;
  /** What the customer was told. */
  notice: string;
}

const CHANNEL_TH: Record<string, string> = {
  line: 'LINE',
  facebook: 'Facebook',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  email: 'อีเมล',
  web: 'เว็บแชต',
  callcenter: 'D-Callcenter',
  api: 'API',
};

/**
 * CD-282 (CD-23 AI CARE) — a service case from a conversation, when the
 * customer accepts the offer AI CARE made, a channel asks for it, or the
 * service team opens it. It is raised through the AI CARE intake channel
 * (CD-66: its requester, the service job type, a status link for the
 * customer) and its service level counts from when AI CARE first took the
 * matter, not from when a person picks it up. A verified sender's case is
 * made a service job for their customer at once; any other waits for the
 * team to tie it to a customer (the work-order "attach").
 */
@Injectable()
export class CareCaseService {
  private readonly logger = new Logger(CareCaseService.name);

  constructor(
    private readonly conversations: CareConversationRepository,
    private readonly messages: CareMessageRepository,
    private readonly lookup: CareContactLookupRepository,
    private readonly channels: RequestIntakeChannelRepository,
    private readonly crmConfigs: CrmConfigRepository,
    private readonly assets: ServiceAssetRepository,
    private readonly requests: RequestsService,
    private readonly workOrders: WorkOrdersService,
    private readonly pm: PmPlanService,
    private readonly llm: LlmService,
    private readonly audit: AuditWriter,
    private readonly config: ConfigService,
  ) {}

  async open(
    conversation: ConversationRow,
    input: {
      by: 'customer' | 'channel' | 'staff';
      actorId?: string | null;
      severity?: Severity;
      subject?: string;
    },
  ): Promise<CareCase> {
    if (conversation.caseRequestId)
      throw new AppError('CONFLICT', 'เปิดเคสจากบทสนทนานี้แล้ว');
    if (conversation.status === 'closed')
      throw new AppError('CONFLICT', 'บทสนทนานี้ปิดแล้ว');
    const { companyId } = conversation;

    const config = (await this.crmConfigs.findFirst({
      where: { companyId },
      select: { serviceWorkOrderTypeCode: true },
    })) as { serviceWorkOrderTypeCode: string | null } | null;
    if (!config?.serviceWorkOrderTypeCode)
      throw new AppError(
        'CONFLICT',
        'ยังไม่ได้ตั้งประเภทคำขอใบสั่งงานบริการในหน้าตั้งค่า CRM',
      );
    const channel = (await this.channels.findFirst({
      where: { companyId, channel: 'ai_care', enabled: true },
      select: { requesterUserId: true },
    })) as { requesterUserId: string } | null;
    if (!channel)
      throw new AppError(
        'CONFLICT',
        'ยังไม่ได้เปิดช่องทางรับเรื่อง AI CARE ในหน้าตั้งค่าช่องทางรับคำขอ',
      );

    const history = (await this.messages.findMany({
      where: { conversationId: conversation.id },
      orderBy: [{ createdAt: 'asc' }],
      take: 200,
      select: { direction: true, author: true, text: true },
    })) as { direction: string; author: string; text: string | null }[];
    const verified =
      conversation.identification === 'verified' && !!conversation.customerId;
    const customer = verified
      ? await this.lookup.customer(conversation.customerId!)
      : null;
    const contact =
      verified && conversation.contactId
        ? await this.lookup.contactDetail(conversation.contactId)
        : null;
    const sender =
      contact?.name ?? conversation.senderName ?? conversation.senderRef;

    const severity =
      input.severity ??
      severityOf(
        history.filter((m) => m.direction === 'in').map((m) => m.text),
        {
          critical: wordsFrom(
            this.config.get<string>('care.severityCritical'),
            DEFAULT_SEVERITY_WORDS.critical,
          ),
          high: wordsFrom(
            this.config.get<string>('care.severityHigh'),
            DEFAULT_SEVERITY_WORDS.high,
          ),
          low: wordsFrom(
            this.config.get<string>('care.severityLow'),
            DEFAULT_SEVERITY_WORDS.low,
          ),
        },
      );
    const subject = input.subject?.trim().slice(0, 200) || caseSubject(history);
    const detail = caseDetail({
      channel: CHANNEL_TH[conversation.channel] ?? conversation.channel,
      sender,
      summary: await this.summary(companyId, history),
      messages: history,
    });

    const principal = await this.pm.principalOf(
      channel.requesterUserId,
      companyId,
    );
    const { detail: created, statusToken } =
      await this.requests.createFromChannel(
        {
          companyId,
          channel: 'ai_care',
          typeCode: config.serviceWorkOrderTypeCode,
          requesterUserId: channel.requesterUserId,
          formData: {
            subject,
            detail,
            ...(customer ? { customer_code: customer.customerCode } : {}),
            work_kind: 'corrective',
          },
          severity,
          contact: {
            name: sender.slice(0, 200),
            email:
              contact?.email ??
              (conversation.channel === 'email'
                ? conversation.senderRef
                : null),
            phone:
              contact?.phone ??
              (conversation.channel === 'callcenter'
                ? conversation.senderRef
                : null),
            lineUserId:
              conversation.channel === 'line' ? conversation.senderRef : null,
          },
          ref: customer
            ? { type: 'customer', id: customer.customerCode }
            : null,
          // the service level counts from when AI CARE took the matter
          receivedAt: conversation.openedAt,
        },
        principal,
        '',
      );
    const request = created as unknown as {
      id: string;
      requestNo: string | null;
    };

    let workOrder = false;
    if (customer) {
      try {
        await this.workOrders.attach(principal, request.id, {
          customer_id: customer.id,
          ...(await this.onlyAsset(companyId, customer.id)),
          work_kind: 'corrective',
        });
        workOrder = true;
      } catch (error) {
        // the case stands; the team ties it to the job from the case page
        this.logger.warn(
          `care case ${request.id}: not made a service job: ${String(error)}`,
        );
      }
    }

    const base = this.config
      .get<string>('care.publicWebUrl')
      ?.replace(/\/+$/, '');
    const statusLink = base ? `${base}/f/status/${statusToken}` : null;
    const notice = caseNotice({
      requestNo: request.requestNo,
      severity,
      statusLink,
    });
    const now = new Date();
    await this.conversations.update({
      where: { id: conversation.id },
      data: {
        caseRequestId: request.id,
        caseOpenedAt: now,
        caseOfferedAt: null,
      },
    });
    await this.audit.record({
      eventType: 'care.case.opened',
      companyId,
      actorId: input.actorId ?? null,
      actorUsername: input.actorId ? null : `care:${input.by}`,
      resourceType: 'care_conversation',
      resourceId: conversation.id,
      after: {
        requestId: request.id,
        requestNo: request.requestNo,
        severity,
        workOrder,
        by: input.by,
      },
    });
    return {
      requestId: request.id,
      requestNo: request.requestNo,
      severity,
      statusLink,
      workOrder,
      notice,
    };
  }

  /** The customer's one installed asset, when there is exactly one. */
  private async onlyAsset(companyId: string, customerId: string) {
    const rows = (await this.assets.findMany({
      where: { companyId, customerId, status: 'active' },
      select: { id: true },
      take: 2,
    })) as { id: string }[];
    return rows.length === 1 ? { asset_id: rows[0].id } : {};
  }

  /** Two or three lines for the team, when a model is there to write them. */
  private async summary(
    companyId: string,
    history: { direction: string; text: string | null }[],
  ) {
    if (this.llm.mode === 'mock') return null;
    const said = history
      .filter((m) => m.direction === 'in' && m.text)
      .map((m) => m.text)
      .join('\n')
      .slice(0, 4000);
    if (!said) return null;
    try {
      const result = await this.llm.chat(
        { companyId, userId: null, task: 'summary' },
        [
          {
            role: 'system',
            content:
              'สรุปปัญหาที่ลูกค้าแจ้งให้ทีมบริการอ่าน 2-3 บรรทัด ภาษาไทย ระบุอุปกรณ์ อาการ และตั้งแต่เมื่อไหร่ถ้ามี ห้ามเดาสิ่งที่ลูกค้าไม่ได้บอก',
          },
          { role: 'user', content: said },
        ],
        { maxTokens: 300, temperature: 0.2 },
      );
      return result.text.trim().slice(0, 1000) || null;
    } catch (error) {
      this.logger.warn(`care case summary skipped: ${String(error)}`);
      return null;
    }
  }
}
