import { Injectable, Logger } from '@nestjs/common';
import {
  AppError,
  Principal,
  salesAccessSubject,
  visibleLeadsWhere,
  visibleSalesWhere,
} from '@request-management/share';
import { LeadFilesService } from '../crm/lead-files.service';
import { QuotationsService } from '../crm/quotations.service';
import {
  LeadRepository,
  OpportunityRepository,
  QuotationRepository,
} from '../crm/sales.repositories';
import { DOMAIN_EVENTS } from '../events/event-catalog';
import {
  WorkflowStartRepository,
  WorkflowTriggerRepository,
} from '../workflow-trigger/workflow-trigger.repository';
import { CrmEmailRepository } from './crm-email.repository';
import { MailClientsService } from './mail-clients.service';
import { looksLikeEmail } from './mail-rules';
import { SalesAutomationIssueRepository } from './sales-automation-issue.repository';
import { itemsFromLead } from './sales-mail.service';

/** The three workflows of the sales flow, plus what all of them need. */
export const SALES_STEPS = ['base', 'intro', 'quote', 'close'] as const;
export type SalesStep = (typeof SALES_STEPS)[number];

/** Which workflow each plugin action belongs to — what the screen groups by. */
export const ACTION_STEP: Record<string, Exclude<SalesStep, 'base'>> = {
  send_lead_email: 'intro',
  convert_lead: 'quote',
  create_standard_quotation: 'quote',
  send_quotation_email: 'quote',
  accept_quotation: 'close',
};

/** Where a failed call landed: any one of these, inside the key's company. */
export interface AutomationTarget {
  leadId?: string;
  opportunityId?: string;
  quotationId?: string;
}

export interface Check {
  key: string;
  ok: boolean;
  label: string;
  detail: string | null;
}

export interface StepView {
  key: SalesStep;
  label: string;
  ok: boolean;
  checks: Check[];
}

interface LeadRow {
  id: string;
  companyId: string;
  email: string | null;
  ownerUserId: string | null;
  convertedOpportunityId: string | null;
  subProduct: string | null;
  intakeData: unknown;
}

interface DealRow {
  id: string;
  companyId: string;
  ownerUserId: string | null;
  currency: string;
  prospectEmail: string | null;
}

interface IssueRow {
  id: string;
  step: string;
  action: string;
  code: string;
  message: string;
  details: unknown;
  occurredAt: Date;
}

interface StartRow {
  triggerId: string;
  resourceId: string;
  status: string;
  lastError: string | null;
  startedAt: Date | null;
  createdAt: Date;
}

/** Codes that mean "nothing of ours to show": the target was out of reach. */
const NOT_RECORDED = new Set(['NOT_FOUND', 'FORBIDDEN', 'UNAUTHORIZED']);

const LEAD_SELECT = {
  id: true,
  companyId: true,
  email: true,
  ownerUserId: true,
  convertedOpportunityId: true,
  subProduct: true,
  intakeData: true,
} as const;

const DEAL_SELECT = {
  id: true,
  companyId: true,
  ownerUserId: true,
  currency: true,
  prospectEmail: true,
} as const;

/**
 * Why the sales workflows would not run, or did not (11 พ.ย. 2569, ผู้ใช้สั่ง):
 * a live checklist of what each workflow needs from the Lead/deal and the
 * company's settings, plus the last real refusal of a `crm/ai/*` call that is
 * not fixed yet. External-service records the refusals; the Lead and deal
 * pages read both. Nothing here decides the process — OSD Workflow does.
 */
@Injectable()
export class SalesAutomationService {
  private readonly logger = new Logger(SalesAutomationService.name);

  constructor(
    private readonly issues: SalesAutomationIssueRepository,
    private readonly leads: LeadRepository,
    private readonly opportunities: OpportunityRepository,
    private readonly quotationRows: QuotationRepository,
    private readonly quotations: QuotationsService,
    private readonly leadFiles: LeadFilesService,
    private readonly emails: CrmEmailRepository,
    private readonly clients: MailClientsService,
    private readonly triggers: WorkflowTriggerRepository,
    private readonly starts: WorkflowStartRepository,
  ) {}

  // --- written by external-service -----------------------------------------

  /**
   * Keeps a refusal of a workflow call. Only an `AppError` about something of
   * the key's company is kept; a lookup that failed (404) is the caller's own
   * mistake and has nothing to show on a page. Never throws: the caller's
   * answer is the refusal itself.
   */
  async record(
    target: AutomationTarget,
    action: string,
    error: unknown,
    actor: Principal,
  ): Promise<void> {
    if (!(error instanceof AppError) || NOT_RECORDED.has(error.code)) return;
    const step = ACTION_STEP[action];
    if (!step) return;
    try {
      const where = await this.locate(target, actor.activeCompanyId);
      if (!where) return;
      await this.issues.create({
        data: {
          companyId: actor.activeCompanyId,
          leadId: where.leadId,
          opportunityId: where.opportunityId,
          step,
          action,
          code: error.code,
          message: error.message.slice(0, 1000),
          details: error.details.map((detail) => ({ ...detail })) as never,
        },
      });
    } catch (failure) {
      this.logger.warn(
        `record sales automation issue failed: ${failure instanceof Error ? failure.message : String(failure)}`,
      );
    }
  }

  /** The same action went through: its earlier refusals are fixed. */
  async resolve(
    target: AutomationTarget,
    action: string,
    actor: Principal,
  ): Promise<void> {
    try {
      const where = await this.locate(target, actor.activeCompanyId);
      if (!where) return;
      await this.issues.updateMany({
        where: {
          companyId: actor.activeCompanyId,
          action,
          resolvedAt: null,
          OR: [
            ...(where.leadId ? [{ leadId: where.leadId }] : []),
            ...(where.opportunityId
              ? [{ opportunityId: where.opportunityId }]
              : []),
          ],
        },
        data: { resolvedAt: new Date() },
      });
    } catch (failure) {
      this.logger.warn(
        `resolve sales automation issue failed: ${failure instanceof Error ? failure.message : String(failure)}`,
      );
    }
  }

  // --- read by the screens -------------------------------------------------

  async forLead(leadId: string, actor: Principal) {
    const lead = (await this.leads.findFirst({
      where: {
        id: leadId,
        AND: [visibleLeadsWhere(salesAccessSubject(actor))],
      },
      select: LEAD_SELECT,
    })) as LeadRow | null;
    if (!lead) throw new AppError('NOT_FOUND', 'ไม่พบ Lead ที่ระบุ');
    const deal = lead.convertedOpportunityId
      ? ((await this.opportunities.findFirst({
          where: { id: lead.convertedOpportunityId },
          select: DEAL_SELECT,
        })) as DealRow | null)
      : null;
    return this.status(lead.companyId, lead, deal);
  }

  async forOpportunity(opportunityId: string, actor: Principal) {
    const deal = (await this.opportunities.findFirst({
      where: {
        id: opportunityId,
        AND: [visibleSalesWhere(salesAccessSubject(actor))],
      },
      select: DEAL_SELECT,
    })) as DealRow | null;
    if (!deal) throw new AppError('NOT_FOUND', 'ไม่พบโอกาสการขายที่ระบุ');
    const lead = (await this.leads.findFirst({
      where: { convertedOpportunityId: deal.id, companyId: deal.companyId },
      select: LEAD_SELECT,
    })) as LeadRow | null;
    return this.status(deal.companyId, lead, deal);
  }

  private async status(
    companyId: string,
    lead: LeadRow | null,
    deal: DealRow | null,
  ) {
    const triggers = (await this.triggers.findMany({
      where: {
        companyId,
        active: true,
        eventKey: {
          in: [DOMAIN_EVENTS.leadStatusChanged, DOMAIN_EVENTS.crmEmailReceived],
        },
      },
      select: { id: true, name: true, eventKey: true, typeCodes: true },
    })) as {
      id: string;
      name: string;
      eventKey: string;
      typeCodes: string[];
    }[];
    const listening = (eventKey: string, ...values: string[]) =>
      triggers.filter(
        (trigger) =>
          trigger.eventKey === eventKey &&
          (!trigger.typeCodes.length ||
            values.some((value) => trigger.typeCodes.includes(value))),
      );
    const introTriggers = listening(
      DOMAIN_EVENTS.leadStatusChanged,
      'negotiation',
    );
    const quoteTriggers = listening(
      DOMAIN_EVENTS.crmEmailReceived,
      'interested',
    );
    const closeTriggers = listening(
      DOMAIN_EVENTS.crmEmailReceived,
      'confirmed',
      'purchase_order',
    );

    const [mail, issues, starts] = await Promise.all([
      this.clients.forCompany(companyId),
      this.openIssues(companyId, lead?.id ?? null, deal?.id ?? null),
      this.startsFor(
        lead,
        deal,
        [...introTriggers, ...quoteTriggers, ...closeTriggers].map(
          (trigger) => trigger.id,
        ),
      ),
    ]);
    const address = deal?.prospectEmail ?? lead?.email ?? null;

    const steps: StepView[] = [
      step('base', 'ค่าพื้นฐานของงานขายอัตโนมัติ', [
        {
          key: 'mailbox',
          ok: mail.mode !== 'off' && !mail.problem,
          label: 'อีเมลงานขายของบริษัท',
          detail:
            mail.mode === 'off'
              ? 'ยังไม่ได้ตั้งค่า — ตั้งค่า → อีเมลงานขาย'
              : (mail.problem ??
                (mail.mode === 'mock' ? 'โหมดจำลอง: อีเมลไม่ออกจริง' : null)),
        },
        {
          key: 'email',
          ok: looksLikeEmail(address),
          label: 'อีเมลผู้ติดต่อ',
          detail: looksLikeEmail(address)
            ? address
            : 'ยังไม่มีอีเมลผู้ติดต่อบน Lead/ดีล',
        },
      ]),
    ];

    if (lead) {
      const proposal = await this.leadFiles.proposalMeta(lead.id);
      steps.push(
        step('intro', 'อีเมลขอบคุณ + proposal (เมื่อ Lead เข้า Negotiation)', [
          triggerCheck(introTriggers, 'Lead เปลี่ยนสถานะ · negotiation'),
          {
            key: 'proposal',
            ok: !!proposal,
            label: 'ไฟล์ Proposal บน Lead',
            detail: proposal
              ? proposal.fileName
              : 'ยังไม่มี — วางไฟล์ประเภท Proposal ที่การ์ด ไฟล์',
          },
          ...startCheck(starts, introTriggers, [lead.id]),
        ]),
      );
    }

    const quoteChecks: Check[] = [
      triggerCheck(quoteTriggers, 'ลูกค้าตอบอีเมล · interested'),
      {
        key: 'owner',
        ok: !!(deal ?? lead)?.ownerUserId,
        label: 'ผู้รับผิดชอบ',
        detail: (deal ?? lead)?.ownerUserId
          ? null
          : 'Lead ยังไม่มีผู้รับผิดชอบ — แปลงเป็นดีลอัตโนมัติไม่ได้',
      },
      await this.productCheck(companyId, lead, deal),
    ];
    const emailIds = await this.emailIds(lead, deal);
    quoteChecks.push(...startCheck(starts, quoteTriggers, emailIds));
    steps.push(
      step('quote', 'ใบเสนอราคาอัตโนมัติ (เมื่อลูกค้าตอบว่าสนใจ)', quoteChecks),
    );

    const closeChecks: Check[] = [
      triggerCheck(
        closeTriggers,
        'ลูกค้าตอบอีเมล · confirmed / purchase_order',
      ),
    ];
    if (deal) {
      const quotation = (await this.quotationRows.findFirst({
        where: {
          opportunityId: deal.id,
          status: { in: ['sent', 'accepted'] },
        },
        orderBy: { createdAt: 'desc' },
        select: { quotationNo: true, status: true },
      })) as { quotationNo: string; status: string } | null;
      closeChecks.push({
        key: 'quotation_sent',
        ok: !!quotation,
        label: 'ใบเสนอราคาที่ส่งให้ลูกค้าแล้ว',
        detail: quotation
          ? `${quotation.quotationNo}${quotation.status === 'accepted' ? ' · ลูกค้ายืนยันแล้ว' : ''}`
          : 'ยังไม่มีใบที่ส่งแล้ว',
      });
    }
    closeChecks.push(...startCheck(starts, closeTriggers, emailIds));
    steps.push(
      step(
        'close',
        'บันทึกลูกค้ายืนยัน (เมื่อลูกค้ายืนยัน/ส่ง PO)',
        closeChecks,
      ),
    );

    return {
      /** the company runs the sales workflows at all — no trigger = hide the card */
      in_use: triggers.some(
        (trigger) =>
          introTriggers.includes(trigger) ||
          quoteTriggers.includes(trigger) ||
          closeTriggers.includes(trigger),
      ),
      ok: issues.length === 0 && steps.every((one) => one.ok),
      issues: issues.map((issue) => ({
        id: issue.id,
        step: issue.step,
        action: issue.action,
        code: issue.code,
        message: issue.message,
        hint: hintFor(issue),
        occurred_at: issue.occurredAt,
      })),
      steps,
    };
  }

  private async productCheck(
    companyId: string,
    lead: LeadRow | null,
    deal: DealRow | null,
  ): Promise<Check> {
    const items = itemsFromLead(lead);
    if (!items.length) {
      return {
        key: 'products',
        ok: false,
        label: 'สินค้าที่มีราคามาตรฐาน',
        detail: 'ยังไม่มีสินค้าบน Lead — ใส่ Sub Product (รหัสสินค้า)',
      };
    }
    const codes = [...new Set(items.map((item) => item.product_code.trim()))];
    const { products, priceOf } = await this.quotations.standardPricesFor(
      companyId,
      codes,
      deal?.currency ?? 'THB',
    );
    const missing = codes.filter(
      (code) => !products.has(code) || !priceOf.has(code),
    );
    return {
      key: 'products',
      ok: missing.length === 0,
      label: 'สินค้าที่มีราคามาตรฐาน',
      detail: missing.length
        ? `ไม่มีราคามาตรฐานที่มีผลวันนี้: ${missing.join(', ')}`
        : codes.join(', '),
    };
  }

  private async openIssues(
    companyId: string,
    leadId: string | null,
    opportunityId: string | null,
  ): Promise<IssueRow[]> {
    if (!leadId && !opportunityId) return [];
    const rows = (await this.issues.findMany({
      where: {
        companyId,
        resolvedAt: null,
        OR: [
          ...(leadId ? [{ leadId }] : []),
          ...(opportunityId ? [{ opportunityId }] : []),
        ],
      },
      orderBy: { occurredAt: 'desc' },
      take: 20,
    })) as IssueRow[];
    // the newest refusal of each action is the one that still stands
    const seen = new Set<string>();
    return rows.filter((row) => {
      if (seen.has(row.action)) return false;
      seen.add(row.action);
      return true;
    });
  }

  private async emailIds(
    lead: LeadRow | null,
    deal: DealRow | null,
  ): Promise<string[]> {
    if (!lead && !deal) return [];
    const rows = (await this.emails.findMany({
      where: {
        direction: 'in',
        OR: [
          ...(lead ? [{ leadId: lead.id }] : []),
          ...(deal ? [{ opportunityId: deal.id }] : []),
        ],
      },
      orderBy: { occurredAt: 'desc' },
      take: 20,
      select: { id: true },
    })) as { id: string }[];
    return rows.map((row) => row.id);
  }

  private async startsFor(
    lead: LeadRow | null,
    deal: DealRow | null,
    triggerIds: string[],
  ): Promise<StartRow[]> {
    if (!triggerIds.length) return [];
    const resourceIds = [
      ...(lead ? [lead.id] : []),
      ...(await this.emailIds(lead, deal)),
    ];
    if (!resourceIds.length) return [];
    return await this.starts.findMany({
      where: { triggerId: { in: triggerIds }, resourceId: { in: resourceIds } },
      orderBy: { createdAt: 'desc' },
      select: {
        triggerId: true,
        resourceId: true,
        status: true,
        lastError: true,
        startedAt: true,
        createdAt: true,
      },
    });
  }

  /** The Lead and/or deal a target names, inside the company — null = none. */
  private async locate(
    target: AutomationTarget,
    companyId: string,
  ): Promise<{ leadId: string | null; opportunityId: string | null } | null> {
    if (target.leadId) {
      const lead = (await this.leads.findFirst({
        where: { id: target.leadId, companyId },
        select: { id: true, convertedOpportunityId: true },
      })) as { id: string; convertedOpportunityId: string | null } | null;
      return lead
        ? { leadId: lead.id, opportunityId: lead.convertedOpportunityId }
        : null;
    }
    let opportunityId = target.opportunityId ?? null;
    if (!opportunityId && target.quotationId) {
      const quotation = (await this.quotationRows.findFirst({
        where: { id: target.quotationId, companyId },
        select: { opportunityId: true },
      })) as { opportunityId: string } | null;
      opportunityId = quotation?.opportunityId ?? null;
    }
    if (!opportunityId) return null;
    const deal = (await this.opportunities.findFirst({
      where: { id: opportunityId, companyId },
      select: { id: true },
    })) as { id: string } | null;
    if (!deal) return null;
    const lead = (await this.leads.findFirst({
      where: { convertedOpportunityId: deal.id, companyId },
      select: { id: true },
    })) as { id: string } | null;
    return { leadId: lead?.id ?? null, opportunityId: deal.id };
  }
}

function step(key: SalesStep, label: string, checks: Check[]): StepView {
  return { key, label, ok: checks.every((check) => check.ok), checks };
}

function triggerCheck(
  found: readonly { name: string }[],
  wanted: string,
): Check {
  return {
    key: 'trigger',
    ok: found.length > 0,
    label: `trigger: ${wanted}`,
    detail: found.length
      ? found.map((trigger) => trigger.name).join(', ')
      : 'ยังไม่ได้ตั้ง — ตั้งค่า → เริ่ม Workflow อัตโนมัติ',
  };
}

/**
 * How the last start went, when there was one. A start that never reached
 * OSD Workflow (`dead`) is a failure to show; one that started is a fact,
 * not a check — except that a Lead starts a trigger's workflow only once.
 */
function startCheck(
  starts: readonly StartRow[],
  triggers: readonly { id: string }[],
  resourceIds: readonly string[],
): Check[] {
  const ids = new Set(triggers.map((trigger) => trigger.id));
  const resources = new Set(resourceIds);
  const last = starts.find(
    (row) => ids.has(row.triggerId) && resources.has(row.resourceId),
  );
  if (!last) return [];
  const when = (last.startedAt ?? last.createdAt).toISOString();
  if (last.status === 'dead') {
    return [
      {
        key: 'start',
        ok: false,
        label: 'เริ่ม workflow',
        detail: `เริ่มไม่สำเร็จ (${when}): ${last.lastError ?? 'ไม่ทราบสาเหตุ'}`,
      },
    ];
  }
  return [
    {
      key: 'start',
      ok: true,
      label: 'เริ่ม workflow',
      detail:
        last.status === 'started'
          ? `เริ่มแล้ว ${when}`
          : `กำลังเริ่ม (${last.status})`,
    },
  ];
}

/** What a salesperson does about a refusal — by code, never by message text. */
export function hintFor(issue: {
  code: string;
  details: unknown;
}): string | null {
  const details = Array.isArray(issue.details)
    ? (issue.details as { field?: string; reason?: string }[])
    : [];
  const has = (field: string, reason?: string) =>
    details.some(
      (detail) =>
        detail.field === field && (!reason || detail.reason === reason),
    );
  switch (issue.code) {
    case 'CRM_EMAIL_UNAVAILABLE':
      if (has('proposal'))
        return 'วางไฟล์ประเภท Proposal ที่การ์ด ไฟล์ บนหน้า Lead';
      if (has('email') || has('prospect_email'))
        return 'เพิ่มอีเมลผู้ติดต่อบน Lead';
      return 'ตั้งค่า → อีเมลงานขาย ของบริษัทนี้';
    case 'CRM_EMAIL_SEND_FAILED':
      return 'ตรวจค่าอีเมลงานขาย (Microsoft Graph) แล้วกดส่งอีเมลทดสอบ';
    case 'CRM_QUOTATION_UNPRICED':
      return has('items', 'no_products')
        ? 'ใส่สินค้า (Sub Product) บน Lead'
        : 'เพิ่มราคามาตรฐานของสินค้านี้ หรือให้พนักงานขายทำใบเสนอราคาเอง';
    case 'CONFLICT':
      if (has('owner_user_id', 'unowned')) return 'กำหนดผู้รับผิดชอบ Lead';
      return null;
    default:
      return null;
  }
}
