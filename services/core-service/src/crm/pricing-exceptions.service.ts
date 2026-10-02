import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AppError,
  Principal,
  PrismaTransactionService,
  salesAccessSubject,
  visibleSalesWhere,
} from '@request-management/share';
import { ApprovalCaseRepository } from '../approvals/approval-case.repository';
import { CompanyMemberRepository } from '../access/company-member.repository';
import { RequestRepository } from '../requests/request.repository';
import {
  OpportunityRepository,
  PricingExceptionRepository,
  QuotationRepository,
} from './sales.repositories';
import { CrmConfigRepository } from './segment.repositories';
import { cleanMinMargins, marginByWorkType } from './quotation-math';

export const EXCEPTION_KINDS = [
  'margin_below',
  'price_override',
  'discount_option',
] as const;
export type ExceptionKind = (typeof EXCEPTION_KINDS)[number];

export type ExceptionOutcome = 'approved' | 'rejected' | 'cancelled';

const LIST_LIMIT = 200;

interface Line {
  lineNo: number;
  productCode: string | null;
  description: string;
  workType: string | null;
  unitPrice: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
  lineCost: Prisma.Decimal;
  systemPrice: Prisma.Decimal | null;
  overrideReason: string | null;
  overriddenBy: string | null;
}

interface QuotationRow {
  id: string;
  companyId: string;
  quotationNo: string;
  version: number;
  opportunityId: string;
  customerId: string | null;
  partyName: string;
  currency: string;
  netTotal: Prisma.Decimal;
  ownerUserId: string;
  lines: Line[];
}

export interface ListExceptionsQuery {
  kind?: string;
  customer_id?: string;
  opportunity_id?: string;
  /** The deal being worked: the same customer's other deals. */
  for_opportunity?: string;
  q?: string;
  from?: string;
  to?: string;
}

/**
 * CD-205 — ทะเบียนข้อยกเว้นด้านราคา: every case a quotation went outside the
 * pricing policy, with the reason and who decided — margin below its work
 * type's minimum (CD-202), a price below the system's (CD-204), a discount an
 * approver chose instead (CD-203).
 *
 * Written when the quotation's price request is decided, from the version on
 * it then, so the register keeps what was approved even if the deal changes
 * later. One row per kind and subject on a request: a decision recorded twice
 * (the outcome event and an approver's choice may both land) updates the row
 * instead of adding one, and a subject the latest version no longer has is
 * marked `superseded`, never deleted.
 *
 * Read by Pricing (`pricing.price.read`, everything) and by sales, who see
 * the rows of deals they can see; margins are masked like a quotation's.
 */
@Injectable()
export class PricingExceptionsService {
  private readonly logger = new Logger(PricingExceptionsService.name);

  constructor(
    private readonly exceptions: PricingExceptionRepository,
    private readonly quotations: QuotationRepository,
    private readonly opportunities: OpportunityRepository,
    private readonly configs: CrmConfigRepository,
    private readonly requests: RequestRepository,
    private readonly cases: ApprovalCaseRepository,
    private readonly members: CompanyMemberRepository,
    private readonly transactions: PrismaTransactionService,
  ) {}

  /**
   * The request's outcome, recorded against the latest version on it.
   * Does nothing for a request no quotation is waiting on.
   */
  async recordOutcome(
    requestId: string,
    outcome: ExceptionOutcome,
  ): Promise<number> {
    const quotation = (await this.quotations.findFirst({
      where: { approvalRequestId: requestId },
      orderBy: { version: 'desc' },
      include: { lines: { orderBy: { lineNo: 'asc' } } },
    })) as QuotationRow | null;
    if (!quotation) return 0;

    const [config, request, approvers] = await Promise.all([
      this.configOf(quotation.companyId),
      this.requests.findFirst({
        where: { id: requestId },
        select: { requestNo: true, formData: true },
      }) as Promise<{ requestNo: string | null; formData: unknown } | null>,
      this.approversOf(requestId, quotation.companyId),
    ]);
    const requestReason =
      typeof (request?.formData as { reason?: unknown } | null)?.reason ===
      'string'
        ? ((request!.formData as { reason: string }).reason ?? null)
        : null;

    const below = marginByWorkType(
      quotation.lines,
      config.byType,
      config.minMarginPct,
    ).filter((group) => group.below);
    const overridden = quotation.lines.filter(
      (line) => line.systemPrice !== null,
    );
    const people = await this.namesOf(
      [
        quotation.ownerUserId,
        ...overridden.map((line) => line.overriddenBy ?? ''),
      ].filter(Boolean),
      quotation.companyId,
    );

    const base = {
      companyId: quotation.companyId,
      requestId,
      requestNo: request?.requestNo ?? null,
      quotationId: quotation.id,
      quotationNo: quotation.quotationNo,
      version: quotation.version,
      opportunityId: quotation.opportunityId,
      customerId: quotation.customerId,
      partyName: quotation.partyName,
      currency: quotation.currency,
      netTotal: quotation.netTotal,
      decision: outcome,
      decidedAt: new Date(),
      approverIds: approvers.ids,
      approverNames: approvers.names,
    };
    const rows: (typeof base & {
      kind: ExceptionKind;
      subjectKey: string;
      [key: string]: unknown;
    })[] = [
      ...below.map((group) => ({
        ...base,
        kind: 'margin_below' as const,
        subjectKey: group.workType ?? 'none',
        workType: group.workType,
        marginPct: group.marginPct,
        minMarginPct: group.minMarginPct,
        reason: requestReason,
        requestedBy: quotation.ownerUserId,
        requestedByName: people.get(quotation.ownerUserId) ?? null,
      })),
      ...overridden.map((line) => ({
        ...base,
        kind: 'price_override' as const,
        subjectKey: `${line.lineNo}:${line.productCode ?? ''}`,
        workType: line.workType,
        productCode: line.productCode,
        description: line.description,
        systemPrice: line.systemPrice,
        unitPrice: line.unitPrice,
        reason: line.overrideReason,
        requestedBy: line.overriddenBy,
        requestedByName: line.overriddenBy
          ? (people.get(line.overriddenBy) ?? null)
          : null,
      })),
    ];

    await this.transactions.execute(async (prisma) => {
      for (const row of rows) {
        const { kind, subjectKey, ...data } = row;
        await prisma.pricingException.upsert({
          where: {
            requestId_kind_subjectKey: { requestId, kind, subjectKey },
          },
          create: { ...data, kind, subjectKey } as never,
          update: data as never,
        });
      }
      // What the latest version no longer has is replaced, not erased.
      for (const kind of ['margin_below', 'price_override'] as const) {
        await prisma.pricingException.updateMany({
          where: {
            requestId,
            kind,
            subjectKey: {
              notIn: rows
                .filter((row) => row.kind === kind)
                .map((row) => row.subjectKey),
            },
          },
          data: { decision: 'superseded' },
        });
      }
      // An approver's chosen discount takes the request's outcome.
      await prisma.pricingException.updateMany({
        where: { requestId, kind: 'discount_option' },
        data: {
          decision: outcome,
          decidedAt: new Date(),
          approverIds: approvers.ids,
          approverNames: approvers.names,
        },
      });
    });
    return rows.length;
  }

  /** CD-203 — an approver approved a smaller discount on this request. */
  async recordChoice(
    requestId: string,
    quotationId: string,
    caps: Record<string, number>,
    note: string,
    actor: Principal,
  ): Promise<void> {
    const quotation = (await this.quotations.findFirst({
      where: { id: quotationId },
      select: {
        companyId: true,
        quotationNo: true,
        version: true,
        opportunityId: true,
        customerId: true,
        partyName: true,
        currency: true,
        netTotal: true,
      },
    })) as Omit<QuotationRow, 'id' | 'lines' | 'ownerUserId'> | null;
    if (!quotation) return;
    const request = (await this.requests.findFirst({
      where: { id: requestId },
      select: { requestNo: true },
    })) as { requestNo: string | null } | null;
    const data = {
      companyId: quotation.companyId,
      requestNo: request?.requestNo ?? null,
      quotationId,
      quotationNo: quotation.quotationNo,
      version: quotation.version,
      opportunityId: quotation.opportunityId,
      customerId: quotation.customerId,
      partyName: quotation.partyName,
      currency: quotation.currency,
      netTotal: quotation.netTotal,
      caps,
      reason: note,
      requestedBy: actor.userId,
      requestedByName: actor.displayName,
      decision: 'pending',
      approverIds: [actor.userId],
      approverNames: [actor.displayName],
    };
    const subjectKey = `v${quotation.version}`;
    await this.exceptions.upsert({
      where: {
        requestId_kind_subjectKey: {
          requestId,
          kind: 'discount_option',
          subjectKey,
        },
      },
      create: { ...data, requestId, kind: 'discount_option', subjectKey },
      update: data,
    });
  }

  /** The outcome events call this; a failure is logged, never thrown. */
  async recordOutcomeQuietly(requestId: string, outcome: ExceptionOutcome) {
    try {
      await this.recordOutcome(requestId, outcome);
    } catch (error) {
      this.logger.error(
        `pricing exception register: request ${requestId} ${outcome} — ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async list(actor: Principal, query: ListExceptionsQuery) {
    const where: Prisma.PricingExceptionWhereInput = {
      companyId: actor.activeCompanyId,
      decision: { not: 'superseded' },
    };
    if (query.kind) {
      if (!(EXCEPTION_KINDS as readonly string[]).includes(query.kind)) {
        throw new AppError('VALIDATION_FAILED', 'ชนิดข้อยกเว้นไม่ถูกต้อง', [
          { field: 'kind', reason: query.kind },
        ]);
      }
      where.kind = query.kind;
    }
    if (query.opportunity_id) where.opportunityId = query.opportunity_id;

    // A customer's register includes the deals it was a prospect on.
    let customerId = query.customer_id ?? null;
    let excludeDeal: string | null = null;
    if (query.for_opportunity) {
      const deal = (await this.opportunities.findFirst({
        where: {
          id: query.for_opportunity,
          companyId: actor.activeCompanyId,
        },
        select: { customerId: true },
      })) as { customerId: string | null } | null;
      if (!deal?.customerId) return { customerId: null, items: [] };
      customerId = deal.customerId;
      excludeDeal = query.for_opportunity;
    }
    if (customerId) {
      const deals = (
        (await this.opportunities.findMany({
          where: { companyId: actor.activeCompanyId, customerId },
          select: { id: true },
        })) as { id: string }[]
      ).map((deal) => deal.id);
      where.OR = [{ customerId }, { opportunityId: { in: deals } }];
    }
    if (excludeDeal) {
      where.AND = [{ opportunityId: { not: excludeDeal } }];
    }
    if (query.q?.trim()) {
      const q = query.q.trim();
      where.AND = [
        ...((where.AND as Prisma.PricingExceptionWhereInput[]) ?? []),
        {
          OR: [
            { partyName: { contains: q, mode: 'insensitive' } },
            { quotationNo: { contains: q, mode: 'insensitive' } },
            { productCode: { contains: q, mode: 'insensitive' } },
          ],
        },
      ];
    }
    if (query.from || query.to) {
      where.createdAt = {
        ...(query.from ? { gte: day(query.from, 'from') } : {}),
        ...(query.to ? { lt: nextDay(day(query.to, 'to')) } : {}),
      };
    }

    let rows = (await this.exceptions.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { subjectKey: 'asc' }],
      take: LIST_LIMIT,
    })) as {
      opportunityId: string;
      marginPct: Prisma.Decimal | null;
      minMarginPct: Prisma.Decimal | null;
      systemPrice: Prisma.Decimal | null;
      unitPrice: Prisma.Decimal | null;
      netTotal: Prisma.Decimal;
    }[];

    // Sales see the rows of the deals they can see; Pricing sees them all.
    if (!actor.permissions.includes('pricing.price.read')) {
      const ids = [...new Set(rows.map((row) => row.opportunityId))];
      const visible = new Set(
        (
          (await this.opportunities.findMany({
            where: {
              id: { in: ids },
              AND: [visibleSalesWhere(salesAccessSubject(actor))],
            },
            select: { id: true },
          })) as { id: string }[]
        ).map((deal) => deal.id),
      );
      rows = rows.filter((row) => visible.has(row.opportunityId));
    }

    return {
      customerId,
      items: rows.map((row) => ({
        ...row,
        marginPct: row.marginPct?.toFixed(2) ?? null,
        minMarginPct: row.minMarginPct?.toFixed(2) ?? null,
        systemPrice: row.systemPrice?.toFixed(2) ?? null,
        unitPrice: row.unitPrice?.toFixed(2) ?? null,
        netTotal: row.netTotal.toFixed(2),
      })),
    };
  }

  /**
   * Fills the register from price requests decided before it existed —
   * idempotent, so it can be run again.
   */
  async backfill(actor: Principal) {
    const pending = (await this.quotations.findMany({
      where: {
        companyId: actor.activeCompanyId,
        approvalRequestId: { not: null },
      },
      select: { approvalRequestId: true },
      distinct: ['approvalRequestId'],
    })) as { approvalRequestId: string }[];
    let requests = 0;
    let rows = 0;
    for (const { approvalRequestId } of pending) {
      const outcome = await this.outcomeOf(
        approvalRequestId,
        actor.activeCompanyId,
      );
      if (!outcome) continue;
      requests += 1;
      rows += await this.recordOutcome(approvalRequestId, outcome);
    }
    return { requests, rows };
  }

  // --- helpers ---------------------------------------------------------------

  /** The newest case decides; one still open has no outcome yet. */
  private async outcomeOf(
    requestId: string,
    companyId: string,
  ): Promise<ExceptionOutcome | null> {
    const [latest] = await this.cases.search(
      { requestId, companyId },
      { skip: 0, take: 1 },
    );
    if (!latest) return null;
    if (latest.status === 'approved') return 'approved';
    if (latest.status === 'rejected') return 'rejected';
    if (latest.status === 'cancelled' || latest.status === 'voided') {
      return 'cancelled';
    }
    return null;
  }

  /** Who decided on the request's cases, in step order. */
  private async approversOf(requestId: string, companyId: string) {
    const cases = await this.cases.search(
      { requestId, companyId },
      { skip: 0, take: 20 },
    );
    const ids = [
      ...new Set(
        cases
          .slice()
          .reverse()
          .flatMap((found) =>
            found.steps
              .filter((step) => step.decidedByUserId)
              .map((step) => step.decidedByUserId as string),
          ),
      ),
    ];
    const names = await this.namesOf(ids, companyId);
    return { ids, names: ids.map((id) => names.get(id) ?? id) };
  }

  private async namesOf(ids: string[], companyId: string) {
    const people = await this.members.findActiveByIds(
      [...new Set(ids)],
      companyId,
    );
    return new Map(people.map((person) => [person.id, person.displayName]));
  }

  private async configOf(companyId: string) {
    const found = (await this.configs.findFirst({
      where: { companyId },
      select: { minMarginPct: true, minMarginByWorkType: true },
    })) as { minMarginPct: number; minMarginByWorkType: unknown } | null;
    return {
      minMarginPct: found?.minMarginPct ?? 15,
      byType: cleanMinMargins(found?.minMarginByWorkType),
    };
  }
}

function day(value: string, field: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new AppError('VALIDATION_FAILED', 'วันที่ไม่ถูกต้อง', [
      { field, reason: 'invalid_date' },
    ]);
  }
  // Business days end at 24:00 +07:00.
  return new Date(`${value}T00:00:00+07:00`);
}

function nextDay(date: Date): Date {
  return new Date(date.getTime() + 24 * 60 * 60 * 1000);
}
