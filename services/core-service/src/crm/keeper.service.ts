import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  accessSubject,
  AppError,
  AuditWriter,
  auditActor,
  customerAccessSubject,
  hasPermission,
  salesAccessSubject,
  visibleCustomersWhere,
  visibleRequestsWhere,
  visibleSalesWhere,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import { CompanyMemberRepository } from '../access/company-member.repository';
import { RequestRepository } from '../requests/request.repository';
import {
  CustomerContractRepository,
  InvoiceOverdueAlertRepository,
} from './contract.repositories';
import { CustomerRepository } from './customer.repository';
import { CustomerTimelineService } from './customer-timeline.service';
import {
  CreateTouchpointDto,
  PortfolioQueryDto,
  SaveAccountPlanDto,
} from './dto/keeper.dto';
import {
  assessHealth,
  CONTRACT_WINDOW_DAYS,
  EXPANSION_TYPES,
  INVOICE_ALERT_LOOKBACK_DAYS,
  nextReviewAfter,
  type HealthLevel,
  type HealthSignal,
} from './keeper-rules';
import {
  CustomerAccountPlanRepository,
  CustomerTouchpointRepository,
} from './keeper.repositories';
import { bangkokDay } from './kyc-rules';
import {
  OpportunityRepository,
  QuotationRepository,
  SaleOrderRepository,
} from './sales.repositories';
import { CrmConfigRepository } from './segment.repositories';

const DAY_MS = 86_400_000;
/** A portfolio is one person's book or a team's — this is plenty. */
export const PORTFOLIO_LIMIT = 300;
const OPEN_STAGES = ['qualifying', 'proposing', 'negotiating'];
const CLOSED_REQUEST = ['completed', 'closed', 'cancelled', 'rejected'];
const TIER_ORDER: Record<string, number> = { a: 0, b: 1, c: 2 };
const HEALTH_ORDER: Record<HealthLevel, number> = {
  red: 0,
  amber: 1,
  green: 2,
};

interface PlanRow {
  tier: 'a' | 'b' | 'c';
  goals: string | null;
  targetRevenue: Prisma.Decimal | null;
  reviewEveryMonths: number;
  nextReviewOn: Date | null;
  updatedAt: Date;
}

interface CustomerRow {
  id: string;
  customerCode: string;
  nameTh: string;
  branchName: string | null;
  status: string;
  createdAt: Date;
  accountOwner: { id: string; displayName: string } | null;
  accountPlan: PlanRow | null;
}

export interface AccountSignals {
  health: { level: HealthLevel; signals: HealthSignal[] };
  last_contact_at: Date | null;
  last_satisfaction: number | null;
  /** null = the viewer may not read deals. */
  open_deals: { count: number; amount: number; expansion: number } | null;
  /** Sale orders in the last 12 months; null = not visible. */
  revenue_12m: number | null;
}

const CUSTOMER_SELECT = {
  id: true,
  customerCode: true,
  nameTh: true,
  branchName: true,
  status: true,
  createdAt: true,
  accountOwner: { select: { id: true, displayName: true } },
  accountPlan: {
    select: {
      tier: true,
      goals: true,
      targetRevenue: true,
      reviewEveryMonths: true,
      nextReviewOn: true,
      updatedAt: true,
    },
  },
} as const;

/**
 * CD-86 — แกน Keeper: รักษาและขยายลูกค้าเดิม (proposal §2.2; user decisions
 * 29 ก.ย. 2569). Four features on the customer register that exists:
 *
 * - **Portfolio & Account Plan** — the accounts a person looks after, with a
 *   tier (A/B/C), growth goals, a revenue target and a review cycle;
 * - **Health Check** — computed from cases (CD-67), overdue-invoice notices
 *   (CD-53), ending contracts (CD-70), time since last contact, and the
 *   owner's satisfaction rating at the last review — the worst wins;
 * - **Review & Reconnect** — each review or contact is a touchpoint; a review
 *   moves the next review date, and the `customer.review` rule reminds;
 * - **Upsell / Cross-sell** — deals carry a type; an account with no open
 *   expansion deal is flagged, and what the customer already buys is shown.
 *
 * Every figure respects the viewer's reach: customers through
 * `visibleCustomersWhere`, deals and orders through `visibleSalesWhere`
 * (only with `crm.sales.read`), cases through `visibleRequestsWhere` (only
 * with `request.read`), invoice notices only with `crm.customer.financial.read`.
 * A signal the viewer may not see is left out, not guessed.
 */
@Injectable()
export class KeeperService {
  constructor(
    private readonly customers: CustomerRepository,
    private readonly plans: CustomerAccountPlanRepository,
    private readonly touchpoints: CustomerTouchpointRepository,
    private readonly opportunities: OpportunityRepository,
    private readonly quotations: QuotationRepository,
    private readonly saleOrders: SaleOrderRepository,
    private readonly contracts: CustomerContractRepository,
    private readonly alerts: InvoiceOverdueAlertRepository,
    private readonly requests: RequestRepository,
    private readonly configs: CrmConfigRepository,
    private readonly members: CompanyMemberRepository,
    private readonly timeline: CustomerTimelineService,
    private readonly audit: AuditWriter,
  ) {}

  async portfolio(
    query: PortfolioQueryDto,
    actor: Principal,
    now: Date = new Date(),
  ) {
    const filters: Prisma.CustomerWhereInput[] = [
      { status: { in: ['active', 'suspended'] }, mergedIntoCustomerId: null },
    ];
    if (query.view === 'mine') {
      filters.push({ accountOwnerUserId: actor.userId });
    }
    if (query.tier === 'none') filters.push({ accountPlan: { is: null } });
    else if (query.tier)
      filters.push({ accountPlan: { is: { tier: query.tier } } });
    if (query.search?.trim()) {
      const q = query.search.trim();
      filters.push({
        OR: [
          { customerCode: { contains: q, mode: 'insensitive' } },
          { nameTh: { contains: q, mode: 'insensitive' } },
          { nameEn: { contains: q, mode: 'insensitive' } },
        ],
      });
    }

    const found = (await this.customers.findMany({
      where: {
        AND: [visibleCustomersWhere(customerAccessSubject(actor)), ...filters],
      },
      select: CUSTOMER_SELECT,
      orderBy: { nameTh: 'asc' },
      take: PORTFOLIO_LIMIT,
    })) as unknown as CustomerRow[];

    const signals = await this.signalsFor(found, actor, now);
    const today = dayStart(now);
    const reviewSoon = new Date(today.getTime() + 7 * DAY_MS);

    const rows = found
      .map((customer) => ({
        ...rowOf(customer),
        ...signals.get(customer.id)!,
      }))
      .filter((row) => !query.health || row.health.level === query.health)
      .sort(
        (a, b) =>
          HEALTH_ORDER[a.health.level] - HEALTH_ORDER[b.health.level] ||
          (TIER_ORDER[a.plan?.tier ?? ''] ?? 3) -
            (TIER_ORDER[b.plan?.tier ?? ''] ?? 3) ||
          a.name_th.localeCompare(b.name_th, 'th'),
      );

    const all = [...signals.values()];
    return {
      rows,
      /** The register had more than {@link PORTFOLIO_LIMIT}; narrow the filters. */
      truncated: found.length === PORTFOLIO_LIMIT,
      summary: {
        accounts: found.length,
        red: all.filter((s) => s.health.level === 'red').length,
        amber: all.filter((s) => s.health.level === 'amber').length,
        green: all.filter((s) => s.health.level === 'green').length,
        without_plan: found.filter((c) => !c.accountPlan).length,
        reviews_due: found.filter(
          (c) =>
            c.accountPlan?.nextReviewOn &&
            c.accountPlan.nextReviewOn <= reviewSoon,
        ).length,
        no_expansion: all.filter(
          (s) => s.open_deals !== null && s.open_deals.expansion === 0,
        ).length,
      },
    };
  }

  /** One account: plan, health, contacts, what it buys, its open deals. */
  async account(customerId: string, actor: Principal, now = new Date()) {
    const customer = await this.requireVisible(customerId, actor);
    const signals = (await this.signalsFor([customer], actor, now)).get(
      customer.id,
    )!;
    const seesSales = hasPermission(actor, 'crm.sales.read');
    const salesWhere = visibleSalesWhere(salesAccessSubject(actor));

    const [touches, orders, contracts, deals] = await Promise.all([
      this.touchpoints.findMany({
        where: { customerId },
        orderBy: { occurredAt: 'desc' },
        take: 50,
      }) as Promise<
        {
          id: string;
          type: string;
          occurredAt: Date;
          summary: string;
          satisfaction: number | null;
          nextSteps: string | null;
          createdBy: string;
        }[]
      >,
      seesSales
        ? (this.saleOrders.findMany({
            where: {
              AND: [
                salesWhere,
                {
                  customerId,
                  status: 'open',
                  orderedAt: { gte: new Date(now.getTime() - 730 * DAY_MS) },
                },
              ],
            },
            select: {
              orderedAt: true,
              lines: {
                select: {
                  productCode: true,
                  description: true,
                  quantity: true,
                  unit: true,
                  lineTotal: true,
                },
              },
            },
          }) as unknown as Promise<
            {
              orderedAt: Date;
              lines: {
                productCode: string | null;
                description: string;
                quantity: Prisma.Decimal;
                unit: string | null;
                lineTotal: Prisma.Decimal;
              }[];
            }[]
          >)
        : Promise.resolve(null),
      this.contracts.findMany({
        where: { customerId, status: 'active' },
        orderBy: { endOn: 'asc' },
        select: {
          id: true,
          contractNo: true,
          title: true,
          endOn: true,
          value: true,
          renewalOpportunityId: true,
        },
      }) as Promise<unknown[]>,
      seesSales
        ? (this.opportunities.findMany({
            where: {
              AND: [salesWhere, { customerId, stage: { in: OPEN_STAGES } }],
            },
            orderBy: { createdAt: 'desc' },
            select: {
              id: true,
              opportunityCode: true,
              title: true,
              stage: true,
              dealType: true,
              amount: true,
              expectedCloseAt: true,
            },
          }) as Promise<unknown[]>)
        : Promise.resolve(null),
    ]);

    const nameOf = await this.displayNames(touches.map((t) => t.createdBy));
    return {
      ...rowOf(customer),
      ...signals,
      plan: customer.accountPlan
        ? {
            ...planView(customer.accountPlan),
            goals: customer.accountPlan.goals,
            updated_at: customer.accountPlan.updatedAt,
          }
        : null,
      touchpoints: touches.map((touch) => ({
        id: touch.id,
        type: touch.type,
        occurred_at: touch.occurredAt,
        summary: touch.summary,
        satisfaction: touch.satisfaction,
        next_steps: touch.nextSteps,
        created_by: nameOf.get(touch.createdBy) ?? touch.createdBy,
      })),
      products: orders ? productsBought(orders) : null,
      contracts,
      open_deals_list: deals,
    };
  }

  async savePlan(
    customerId: string,
    dto: SaveAccountPlanDto,
    actor: Principal,
  ) {
    await this.requireVisible(customerId, actor);
    const before = (await this.plans.findFirst({
      where: { customerId },
    })) as (PlanRow & { id: string }) | null;

    const months = dto.review_every_months ?? before?.reviewEveryMonths ?? 3;
    const nextReviewOn =
      dto.next_review_on !== undefined
        ? dto.next_review_on
          ? dayOf(dto.next_review_on)
          : null
        : // a new plan starts its cycle today
          (before?.nextReviewOn ??
          nextReviewAfter(dayStart(new Date()), months));

    const data = {
      ...(dto.tier ? { tier: dto.tier } : {}),
      ...(dto.goals !== undefined ? { goals: dto.goals.trim() || null } : {}),
      ...(dto.target_revenue !== undefined
        ? { targetRevenue: dto.target_revenue }
        : {}),
      reviewEveryMonths: months,
      nextReviewOn,
      updatedBy: actor.userId,
    };
    const saved = await this.plans.upsert({
      where: { customerId },
      create: {
        companyId: actor.activeCompanyId,
        customerId,
        tier: dto.tier ?? 'b',
        ...data,
        createdBy: actor.userId,
      },
      update: data,
    });

    await this.audit.record({
      eventType: 'crm.account_plan.saved',
      companyId: actor.activeCompanyId,
      ...auditActor(actor),
      resourceType: 'customer',
      resourceId: customerId,
      before: before
        ? {
            tier: before.tier,
            reviewEveryMonths: before.reviewEveryMonths,
            nextReviewOn: before.nextReviewOn,
          }
        : { plan: false },
      after: { ...dto, nextReviewOn },
    });
    return saved;
  }

  /**
   * A review or a contact. A review carries the owner's satisfaction rating
   * and moves the next review date one cycle on from the day it happened.
   */
  async addTouchpoint(
    customerId: string,
    dto: CreateTouchpointDto,
    actor: Principal,
  ) {
    const customer = await this.requireVisible(customerId, actor);
    if (dto.satisfaction !== undefined && dto.type !== 'review') {
      throw new AppError(
        'VALIDATION_FAILED',
        'คะแนนความพึงพอใจใช้กับการทบทวน (review) เท่านั้น',
        [{ field: 'satisfaction', reason: dto.type }],
      );
    }
    const occurredAt = dto.occurred_at ? new Date(dto.occurred_at) : new Date();
    if (occurredAt.getTime() > Date.now() + 60_000) {
      throw new AppError(
        'VALIDATION_FAILED',
        'บันทึกได้เฉพาะการติดต่อที่เกิดขึ้นแล้ว — นัดล่วงหน้าให้ลงเป็นกิจกรรมของดีล',
        [{ field: 'occurred_at', reason: 'future' }],
      );
    }

    const touch = (await this.touchpoints.create({
      data: {
        companyId: actor.activeCompanyId,
        customerId,
        type: dto.type,
        occurredAt,
        summary: dto.summary.trim(),
        satisfaction: dto.satisfaction ?? null,
        nextSteps: dto.next_steps?.trim() || null,
        createdBy: actor.userId,
      },
    })) as { id: string };

    let nextReviewOn: Date | null = null;
    if (dto.type === 'review') {
      const months = customer.accountPlan?.reviewEveryMonths ?? 3;
      nextReviewOn = nextReviewAfter(dayStart(occurredAt), months);
      await this.plans.upsert({
        where: { customerId },
        create: {
          companyId: actor.activeCompanyId,
          customerId,
          reviewEveryMonths: months,
          nextReviewOn,
          createdBy: actor.userId,
          updatedBy: actor.userId,
        },
        update: { nextReviewOn, updatedBy: actor.userId },
      });
    }

    await this.audit.record({
      eventType: 'crm.customer.touchpoint_logged',
      companyId: actor.activeCompanyId,
      ...auditActor(actor),
      resourceType: 'customer',
      resourceId: customerId,
      after: {
        touchpointId: touch.id,
        type: dto.type,
        satisfaction: dto.satisfaction ?? null,
        nextReviewOn,
      },
    });
    await this.timeline.publish({
      companyId: actor.activeCompanyId,
      customerId,
      refType: 'customer',
      refId: customerId,
      eventType:
        dto.type === 'review' ? 'customer.reviewed' : 'customer.contacted',
      summary: dto.summary.trim().slice(0, 300),
      actorId: actor.userId,
      actorName: actor.displayName,
      occurredAt,
    });

    return { id: touch.id, next_review_on: nextReviewOn };
  }

  /**
   * Health and the figures beside it, for many customers in a handful of
   * queries — the portfolio reads up to {@link PORTFOLIO_LIMIT} at once.
   */
  async signalsFor(
    customers: CustomerRow[],
    actor: Principal,
    now: Date,
  ): Promise<Map<string, AccountSignals>> {
    const ids = customers.map((c) => c.id);
    const result = new Map<string, AccountSignals>();
    if (!ids.length) return result;

    const seesSales = hasPermission(actor, 'crm.sales.read');
    const seesCases = hasPermission(actor, 'request.read');
    const seesMoney = hasPermission(actor, 'crm.customer.financial.read');
    const today = dayStart(now);

    const [
      config,
      touches,
      deals,
      visibleDealIds,
      quotes,
      contracts,
      alerts,
      orders,
    ] = await Promise.all([
      this.configs.findFirst({
        where: { companyId: actor.activeCompanyId },
        select: { healthNoContactDays: true },
      }) as Promise<{ healthNoContactDays: number } | null>,
      this.touchpoints.findMany({
        where: {
          customerId: { in: ids },
          occurredAt: { gte: new Date(now.getTime() - 730 * DAY_MS) },
        },
        orderBy: { occurredAt: 'desc' },
        select: {
          customerId: true,
          type: true,
          occurredAt: true,
          satisfaction: true,
        },
      }) as Promise<
        {
          customerId: string;
          type: string;
          occurredAt: Date;
          satisfaction: number | null;
        }[]
      >,
      // every deal: cases may be raised against any of them, and a renewal
      // deal's stage tells the contract signal — only its stage is used.
      this.opportunities.findMany({
        where: { customerId: { in: ids } },
        select: {
          id: true,
          opportunityCode: true,
          customerId: true,
          stage: true,
          dealType: true,
          amount: true,
          lastActivityAt: true,
        },
      }) as Promise<
        {
          id: string;
          opportunityCode: string;
          customerId: string;
          stage: string;
          dealType: string;
          amount: Prisma.Decimal | null;
          lastActivityAt: Date | null;
        }[]
      >,
      seesSales
        ? (this.opportunities.findMany({
            where: {
              AND: [
                visibleSalesWhere(salesAccessSubject(actor)),
                { customerId: { in: ids } },
              ],
            },
            select: { id: true },
          }) as Promise<{ id: string }[]>)
        : Promise.resolve(null),
      seesCases
        ? (this.quotations.findMany({
            where: {
              OR: [
                { customerId: { in: ids } },
                { opportunity: { customerId: { in: ids } } },
              ],
            },
            select: {
              id: true,
              customerId: true,
              opportunity: { select: { customerId: true } },
            },
          }) as unknown as Promise<
            {
              id: string;
              customerId: string | null;
              opportunity: { customerId: string | null } | null;
            }[]
          >)
        : Promise.resolve([]),
      this.contracts.findMany({
        where: {
          customerId: { in: ids },
          status: 'active',
          endOn: {
            gte: today,
            lte: new Date(today.getTime() + CONTRACT_WINDOW_DAYS * DAY_MS),
          },
        },
        select: { customerId: true, endOn: true, renewalOpportunityId: true },
      }) as Promise<
        {
          customerId: string;
          endOn: Date;
          renewalOpportunityId: string | null;
        }[]
      >,
      seesMoney
        ? (this.alerts.findMany({
            where: {
              customerId: { in: ids },
              alertedAt: {
                gte: new Date(
                  now.getTime() - INVOICE_ALERT_LOOKBACK_DAYS * DAY_MS,
                ),
              },
            },
            select: { customerId: true, step: true },
          }) as Promise<{ customerId: string; step: number }[]>)
        : Promise.resolve(null),
      seesSales
        ? (this.saleOrders.findMany({
            where: {
              AND: [
                visibleSalesWhere(salesAccessSubject(actor)),
                {
                  customerId: { in: ids },
                  status: 'open',
                  orderedAt: { gte: new Date(now.getTime() - 365 * DAY_MS) },
                },
              ],
            },
            select: { customerId: true, amount: true },
          }) as Promise<
            { customerId: string; amount: Prisma.Decimal | null }[]
          >)
        : Promise.resolve(null),
    ]);

    const cases = seesCases
      ? await this.casesByCustomer(ids, deals, quotes, actor)
      : null;
    const dealById = new Map(deals.map((deal) => [deal.id, deal]));
    const visible = visibleDealIds
      ? new Set(visibleDealIds.map((row) => row.id))
      : null;
    const noContactDays = config?.healthNoContactDays ?? 60;

    for (const customer of customers) {
      const mine = <T extends { customerId: string | null }>(rows: T[]) =>
        rows.filter((row) => row.customerId === customer.id);
      const myTouches = mine(touches);
      const myDeals = mine(deals);

      const lastTouch = myTouches[0]?.occurredAt ?? null;
      const lastDealActivity = myDeals
        .map((deal) => deal.lastActivityAt)
        .filter((at): at is Date => Boolean(at))
        .sort((a, b) => b.getTime() - a.getTime())[0];
      const lastContactAt =
        [lastTouch, lastDealActivity ?? null]
          .filter((at): at is Date => Boolean(at))
          .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
      const satisfaction =
        myTouches.find((touch) => touch.type === 'review')?.satisfaction ??
        null;

      const ending = mine(contracts).sort(
        (a, b) => a.endOn.getTime() - b.endOn.getTime(),
      );
      const renewalOf = (row: { renewalOpportunityId: string | null }) =>
        row.renewalOpportunityId
          ? dealById.get(row.renewalOpportunityId)
          : undefined;
      const myAlerts = alerts ? mine(alerts) : null;

      const health = assessHealth(
        {
          cases: cases
            ? (cases.get(customer.id) ?? { breached: 0, serious: 0 })
            : null,
          invoiceOverdue:
            myAlerts && myAlerts.length
              ? { maxStep: Math.max(...myAlerts.map((a) => a.step)) }
              : null,
          contracts: {
            endingInDays: ending.length
              ? Math.round(
                  (ending[0].endOn.getTime() - today.getTime()) / DAY_MS,
                )
              : null,
            renewalOpen: ending.some((row) =>
              OPEN_STAGES.includes(renewalOf(row)?.stage ?? ''),
            ),
            renewalLost: ending.some((row) => renewalOf(row)?.stage === 'lost'),
          },
          satisfaction,
          lastContactAt,
          since: customer.createdAt,
        },
        { noContactDays },
        now,
      );

      const openVisible = visible
        ? myDeals.filter(
            (deal) => visible.has(deal.id) && OPEN_STAGES.includes(deal.stage),
          )
        : null;
      result.set(customer.id, {
        health,
        last_contact_at: lastContactAt,
        last_satisfaction: satisfaction,
        open_deals: openVisible
          ? {
              count: openVisible.length,
              amount: sum(openVisible.map((deal) => deal.amount)),
              expansion: openVisible.filter((deal) =>
                (EXPANSION_TYPES as readonly string[]).includes(deal.dealType),
              ).length,
            }
          : null,
        revenue_12m: orders
          ? sum(mine(orders).map((order) => order.amount))
          : null,
      });
    }
    return result;
  }

  /**
   * Open cases (typed with a severity, CD-67) per customer, by the same
   * "about this customer" as the 360° requests tab: the customer itself, one
   * of its deals (code or id), or one of its quotations.
   */
  private async casesByCustomer(
    ids: string[],
    deals: { id: string; opportunityCode: string; customerId: string }[],
    quotes: {
      id: string;
      customerId: string | null;
      opportunity: { customerId: string | null } | null;
    }[],
    actor: Principal,
  ): Promise<Map<string, { breached: number; serious: number }>> {
    const owner = new Map<string, string>();
    for (const deal of deals) {
      owner.set(`opportunity:${deal.opportunityCode}`, deal.customerId);
      owner.set(`opportunity:${deal.id}`, deal.customerId);
    }
    for (const quote of quotes) {
      const customerId = quote.customerId ?? quote.opportunity?.customerId;
      if (customerId) owner.set(`quotation:${quote.id}`, customerId);
    }
    for (const id of ids) owner.set(`customer:${id}`, id);

    const refs = (type: string) =>
      [...owner.keys()]
        .filter((key) => key.startsWith(`${type}:`))
        .map((key) => key.slice(type.length + 1));
    const rows = (await this.requests.findMany({
      where: {
        AND: [
          visibleRequestsWhere(accessSubject(actor)),
          { severity: { not: null }, status: { notIn: CLOSED_REQUEST } },
          {
            OR: ['customer', 'opportunity', 'quotation']
              .map((type) => ({ type, ids: refs(type) }))
              .filter((ref) => ref.ids.length)
              .map((ref) => ({ refType: ref.type, refId: { in: ref.ids } })),
          },
        ],
      },
      select: {
        refType: true,
        refId: true,
        severity: true,
        slaClock: {
          select: { breachedAt: true, responseBreachedAt: true },
        },
      },
    })) as unknown as {
      refType: string;
      refId: string;
      severity: string;
      slaClock: {
        breachedAt: Date | null;
        responseBreachedAt: Date | null;
      } | null;
    }[];

    const counts = new Map<string, { breached: number; serious: number }>();
    for (const row of rows) {
      const customerId = owner.get(`${row.refType}:${row.refId}`);
      if (!customerId) continue;
      const count = counts.get(customerId) ?? { breached: 0, serious: 0 };
      if (row.slaClock?.breachedAt || row.slaClock?.responseBreachedAt) {
        count.breached += 1;
      } else if (row.severity === 'critical' || row.severity === 'high') {
        count.serious += 1;
      }
      counts.set(customerId, count);
    }
    return counts;
  }

  /** SCOPE-03: out of reach = 404. */
  private async requireVisible(id: string, actor: Principal) {
    const found = (await this.customers.findFirst({
      where: {
        id,
        mergedIntoCustomerId: null,
        AND: [visibleCustomersWhere(customerAccessSubject(actor))],
      },
      select: CUSTOMER_SELECT,
    })) as unknown as CustomerRow | null;
    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบลูกค้าที่ระบุ');
    return found;
  }

  private async displayNames(ids: string[]) {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map<string, string>();
    const users = (await this.members.findMany({
      where: { id: { in: unique } },
      select: { id: true, displayName: true },
    })) as { id: string; displayName: string }[];
    return new Map(users.map((user) => [user.id, user.displayName]));
  }
}

function rowOf(customer: CustomerRow) {
  return {
    id: customer.id,
    customer_code: customer.customerCode,
    name_th: customer.nameTh,
    branch_name: customer.branchName,
    status: customer.status,
    owner: customer.accountOwner,
    plan: customer.accountPlan ? planView(customer.accountPlan) : null,
  };
}

function planView(plan: PlanRow) {
  return {
    tier: plan.tier,
    target_revenue:
      plan.targetRevenue === null ? null : Number(plan.targetRevenue),
    review_every_months: plan.reviewEveryMonths,
    next_review_on: plan.nextReviewOn
      ? plan.nextReviewOn.toISOString().slice(0, 10)
      : null,
  };
}

/** What the customer buys — one row per product (or description when free text). */
function productsBought(
  orders: {
    orderedAt: Date;
    lines: {
      productCode: string | null;
      description: string;
      quantity: Prisma.Decimal;
      unit: string | null;
      lineTotal: Prisma.Decimal;
    }[];
  }[],
) {
  const byKey = new Map<
    string,
    {
      product_code: string | null;
      description: string;
      unit: string | null;
      quantity: number;
      amount: number;
      last_ordered_on: string;
      orders: number;
    }
  >();
  for (const order of orders) {
    const on = order.orderedAt.toISOString().slice(0, 10);
    for (const line of order.lines) {
      const key = line.productCode ?? `text:${line.description.trim()}`;
      const row = byKey.get(key) ?? {
        product_code: line.productCode,
        description: line.description,
        unit: line.unit,
        quantity: 0,
        amount: 0,
        last_ordered_on: on,
        orders: 0,
      };
      row.quantity += Number(line.quantity);
      row.amount = round2(row.amount + Number(line.lineTotal));
      row.orders += 1;
      if (on > row.last_ordered_on) row.last_ordered_on = on;
      byKey.set(key, row);
    }
  }
  return [...byKey.values()].sort((a, b) => b.amount - a.amount);
}

function sum(values: (Prisma.Decimal | number | null)[]): number {
  return round2(values.reduce<number>((total, v) => total + Number(v ?? 0), 0));
}

const round2 = (value: number) => Math.round(value * 100) / 100;

function dayStart(at: Date): Date {
  return new Date(`${bangkokDay(at)}T00:00:00Z`);
}

function dayOf(iso: string): Date {
  return new Date(`${iso.slice(0, 10)}T00:00:00Z`);
}
