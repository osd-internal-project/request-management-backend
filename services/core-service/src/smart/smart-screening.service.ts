import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AppError,
  AuditWriter,
  auditActor,
  PrismaTransactionService,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import { CampaignLeadIntakeService } from '../crm/campaign-lead-intake.service';
import { normalizeCustomerName } from '../crm/customer-name';
import { LeadStatusService } from '../crm/lead-status.service';
import { CustomerRepository } from '../crm/customer.repository';
import { LeadRepository } from '../crm/sales.repositories';
import { LlmService } from '../llm/llm.service';
import {
  type MatchKind,
  scoreProspect,
  type ScoringCriteria,
} from './smart-scoring';
import {
  SmartProspectRepository,
  SmartSourceRepository,
} from './smart.repositories';

interface Row {
  id: string;
  companyId: string;
  sourceId: string;
  name: string;
  taxId: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  industry: string | null;
  province: string | null;
  registeredCapital: unknown;
  salesAxis: string | null;
  evidence: unknown;
  status: string;
  score: number | null;
  matchKind: string | null;
}

export interface SendResult {
  id: string;
  name: string;
  outcome: 'created' | 'customer' | 'repeat' | 'skipped';
  lead_id: string | null;
  reason?: string;
}

/** The source code a Lead from AI SMART carries in CRM. */
export const SMART_LEAD_SOURCE = 'ai_smart';

/**
 * CD-290 — screening swept businesses before anyone in sales sees them.
 *
 * Each row is matched against CRM (a customer by tax id or name; an open
 * Lead by tax id, name or phone), scored by the rules in `smart-scoring.ts`,
 * and — when a real LLM gateway is on — summarised by the model under task
 * `smart.score`. Screening runs by itself after every batch; it can be run
 * again when CRM has changed. Sending to CRM is a person's decision and goes
 * through the same screening as a campaign's Lead (CD-269), so a business
 * that is already a customer reaches its account owner, not the pool.
 */
@Injectable()
export class SmartScreeningService {
  private readonly logger = new Logger(SmartScreeningService.name);

  constructor(
    private readonly prospects: SmartProspectRepository,
    private readonly sources: SmartSourceRepository,
    private readonly customers: CustomerRepository,
    private readonly leads: LeadRepository,
    private readonly statuses: LeadStatusService,
    private readonly intake: CampaignLeadIntakeService,
    private readonly llm: LlmService,
    private readonly config: ConfigService,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  /** Screens what one sweep added. Never fails the sweep it follows. */
  async screenRun(companyId: string, runId: string): Promise<number> {
    try {
      const rows = (await this.prospects.findMany({
        where: { companyId, runId, status: 'new' },
        select: { id: true },
      })) as { id: string }[];
      return await this.screen(
        companyId,
        rows.map((row) => row.id),
      );
    } catch (error) {
      this.logger.warn(`screening run ${runId}: ${(error as Error).message}`);
      return 0;
    }
  }

  /** Re-screens rows still waiting (new or screened); all of them when `ids` is empty. */
  async rescreen(actor: Principal, ids: string[]) {
    const rows = (await this.prospects.findMany({
      where: {
        companyId: actor.activeCompanyId,
        status: { in: ['new', 'screened'] },
        ...(ids.length ? { id: { in: ids } } : {}),
      },
      select: { id: true },
      take: 2000,
    })) as { id: string }[];
    const screened = await this.screen(
      actor.activeCompanyId,
      rows.map((row) => row.id),
    );
    return { screened };
  }

  async screen(companyId: string, ids: string[]): Promise<number> {
    if (!ids.length) return 0;
    const rows = (await this.prospects.findMany({
      where: {
        companyId,
        id: { in: ids },
        status: { in: ['new', 'screened'] },
      },
    })) as Row[];
    const criteria = await this.criteriaOf(companyId, rows);
    const open = (await this.statuses.listAll(companyId))
      .filter((status) => status.kind === 'open')
      .map((status) => status.code);
    const summarise = this.config.get<string>('llm.mode') === 'gateway';

    for (const row of rows) {
      const match = await this.match(companyId, row, open);
      const { score, reasons } = scoreProspect(
        {
          taxId: row.taxId,
          phone: row.phone,
          email: row.email,
          website: row.website,
          industry: row.industry,
          province: row.province,
          registeredCapital:
            row.registeredCapital === null
              ? null
              : Number(row.registeredCapital),
        },
        criteria.get(row.sourceId) ?? {},
        match.kind,
      );
      const aiSummary = summarise
        ? await this.summary(companyId, row, score)
        : null;
      await this.prospects.update({
        where: { id: row.id },
        data: {
          status: 'screened',
          score,
          scoreReasons: reasons as never,
          matchKind: match.kind,
          matchCustomerId: match.customerId,
          matchLeadId: match.leadId,
          screenedAt: new Date(),
          ...(aiSummary !== null ? { aiSummary } : {}),
        },
      });
    }
    return rows.length;
  }

  /** Sends rows to CRM as Leads, through the campaign screening (CD-269). */
  async send(actor: Principal, ids: string[]): Promise<SendResult[]> {
    const rows = (await this.prospects.findMany({
      where: { companyId: actor.activeCompanyId, id: { in: ids } },
    })) as Row[];
    if (rows.length !== new Set(ids).size) {
      throw new AppError('NOT_FOUND', 'ไม่พบรายชื่อที่กวาดได้บางรายการ');
    }
    const sourceCodes = await this.sourceCodes(actor.activeCompanyId, rows);
    const results: SendResult[] = [];
    for (const row of rows) {
      if (row.status === 'sent' || row.status === 'discarded') {
        results.push({
          id: row.id,
          name: row.name,
          outcome: 'skipped',
          lead_id: null,
          reason: row.status === 'sent' ? 'ส่งไปแล้ว' : 'ถูกทิ้งไปแล้ว',
        });
        continue;
      }
      const evidence = (row.evidence ?? {}) as Record<string, unknown>;
      const received = await this.intake.receive(
        {
          name: row.name,
          source_code: SMART_LEAD_SOURCE,
          tax_id: row.taxId ?? undefined,
          phone: row.phone ?? undefined,
          email: row.email ?? undefined,
          industry: row.industry ?? undefined,
          province: row.province ?? undefined,
          note: [
            `AI SMART · แหล่ง ${sourceCodes.get(row.sourceId) ?? ''}`,
            row.score !== null && `คะแนนความพร้อม ${row.score}/100`,
            row.salesAxis && `แกนขาย ${row.salesAxis}`,
            row.website && `เว็บไซต์ ${row.website}`,
            typeof evidence.url === 'string' && `ที่มา ${evidence.url}`,
          ]
            .filter(Boolean)
            .join('\n'),
        },
        actor,
      );
      await this.transactions.execute(async (prisma) => {
        await this.prospects.update(
          {
            where: { id: row.id },
            data: {
              status: 'sent',
              leadId: received.lead.id,
              sentOutcome: received.outcome,
              sentBy: actor.userId,
              sentAt: new Date(),
            },
          },
          { prisma },
        );
        await this.audit.record(
          {
            eventType: 'smart.prospect.sent',
            companyId: actor.activeCompanyId,
            ...auditActor(actor),
            resourceType: 'smart_prospect',
            resourceId: row.id,
            before: { status: row.status },
            after: {
              status: 'sent',
              leadId: received.lead.id,
              outcome: received.outcome,
            },
          },
          { prisma },
        );
      });
      results.push({
        id: row.id,
        name: row.name,
        outcome: received.outcome,
        lead_id: received.lead.id,
      });
    }
    return results;
  }

  // --- helpers ----------------------------------------------------------------

  private async match(
    companyId: string,
    row: Row,
    openStatuses: string[],
  ): Promise<{
    kind: MatchKind;
    customerId: string | null;
    leadId: string | null;
  }> {
    const normalized = normalizeCustomerName(row.name);
    const customer = (await this.customers.findFirst({
      where: {
        companyId,
        OR: [
          ...(row.taxId ? [{ taxId: row.taxId }] : []),
          ...(normalized ? [{ normalizedName: normalized }] : []),
        ],
      },
      select: { id: true },
    })) as { id: string } | null;
    if (customer)
      return { kind: 'customer', customerId: customer.id, leadId: null };

    const lead = (await this.leads.findFirst({
      where: {
        companyId,
        status: { in: openStatuses },
        convertedOpportunityId: null,
        OR: [
          ...(row.taxId ? [{ taxId: row.taxId }] : []),
          { name: { equals: row.name, mode: 'insensitive' as const } },
          ...(row.phone ? [{ phone: { endsWith: row.phone.slice(-9) } }] : []),
        ],
      },
      select: { id: true },
    })) as { id: string } | null;
    if (lead) return { kind: 'lead', customerId: null, leadId: lead.id };
    return { kind: 'none', customerId: null, leadId: null };
  }

  /** The model's two-line take; nothing when the task is off or over quota. */
  private async summary(companyId: string, row: Row, score: number) {
    try {
      const reply = await this.llm.chat(
        { companyId, task: 'smart.score' },
        [
          {
            role: 'system',
            content:
              'คุณช่วยทีมขาย B2B ประเมินธุรกิจเป้าหมาย ตอบภาษาไทยไม่เกิน 2 ประโยค: ' +
              'ธุรกิจนี้น่าจะต้องการอะไร และควรเปิดบทสนทนาอย่างไร ห้ามแต่งข้อมูลที่ไม่มีให้',
          },
          {
            role: 'user',
            content: JSON.stringify({
              name: row.name,
              industry: row.industry,
              province: row.province,
              registered_capital: row.registeredCapital,
              website: row.website,
              axis: row.salesAxis,
              score,
            }),
          },
        ],
        { maxTokens: 200 },
      );
      return reply.text.trim().slice(0, 1000) || null;
    } catch (error) {
      this.logger.warn(
        `smart.score summary skipped: ${(error as Error).message}`,
      );
      return null;
    }
  }

  private async criteriaOf(companyId: string, rows: Row[]) {
    const ids = [...new Set(rows.map((row) => row.sourceId))];
    const sources = (await this.sources.findMany({
      where: { companyId, id: { in: ids } },
      select: { id: true, criteria: true },
    })) as { id: string; criteria: unknown }[];
    return new Map(
      sources.map((source) => [
        source.id,
        (source.criteria ?? {}) as ScoringCriteria,
      ]),
    );
  }

  private async sourceCodes(companyId: string, rows: Row[]) {
    const ids = [...new Set(rows.map((row) => row.sourceId))];
    const sources = (await this.sources.findMany({
      where: { companyId, id: { in: ids } },
      select: { id: true, code: true },
    })) as { id: string; code: string }[];
    return new Map(sources.map((source) => [source.id, source.code]));
  }
}
