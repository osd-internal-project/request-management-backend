import { Injectable } from '@nestjs/common';
import {
  SensitiveFieldMasker,
  type Principal,
} from '@request-management/share';
import {
  ApprovalsService,
  CrmDashboardService,
  KbService,
  OpportunitiesService,
  overdueClockWhere,
  RequestRepository,
  StatusReportsService,
  WorkOrdersService,
} from '@request-management/core-service';
import { RequestApiService } from '../request/request.service';
import type {
  AssistantArticlesQueryDto,
  ClosingDealsQueryDto,
  ProjectsAtRiskQueryDto,
  ServiceJobsQueryDto,
  SilentDealsQueryDto,
} from './assistant.dto';

/** The most rows one answer carries — a chat reads a short list, not a report. */
const MAX_ROWS = 100;
const DAY_MS = 86_400_000;

interface DealRow {
  opportunityCode: string;
  title: string;
  stage: string;
  amount: unknown;
  currency: string | null;
  probability: number | null;
  expectedCloseAt: Date | null;
  customer: { customerCode: string; nameTh: string } | null;
  prospectName: string | null;
  ownerUserId: string | null;
  lastActivityAt: Date | null;
  nextFollowUpAt: Date | null;
}

const day = (value: Date | null) =>
  value ? value.toISOString().slice(0, 10) : null;

function deal(row: DealRow) {
  return {
    code: row.opportunityCode,
    title: row.title,
    customer: row.customer?.nameTh ?? row.prospectName,
    stage: row.stage,
    amount: row.amount === null ? null : Number(row.amount),
    currency: row.currency,
    probability: row.probability,
    expected_close_on: day(row.expectedCloseAt),
    last_activity_on: day(row.lastActivityAt),
    next_follow_up_on: day(row.nextFollowUpAt),
  };
}

const has = (actor: Principal, permission: string) =>
  (actor.permissions as readonly string[]).includes(permission);

/**
 * CD-276 — the answers behind the personal assistant's questions.
 *
 * Nothing here decides who sees what. Every answer is the screen's own
 * service called as the person asking — `visibleSalesWhere` for deals, the
 * approval inbox's rule, `runningVisible` for projects — so the assistant
 * can never tell anybody more than their own screens would. What this adds
 * is only the shape a chat wants: short rows, plain field names, the count
 * beside the list so "and how many more?" has an answer.
 */
@Injectable()
export class AssistantService {
  constructor(
    private readonly opportunities: OpportunitiesService,
    private readonly approvals: ApprovalsService,
    private readonly statusReports: StatusReportsService,
    private readonly workOrders: WorkOrdersService,
    private readonly kb: KbService,
    private readonly crmDashboard: CrmDashboardService,
    private readonly requestApi: RequestApiService,
    private readonly requestRows: RequestRepository,
    private readonly masker: SensitiveFieldMasker,
  ) {}

  /** Open deals expected to close within `days` — late ones first. */
  async closingDeals(actor: Principal, query: ClosingDealsQueryDto) {
    const days = query.days ?? 30;
    const page = (await this.opportunities.list(actor, {
      page: 1,
      page_size: MAX_ROWS,
      closing_within_days: days,
      view: query.view,
    })) as { data: DealRow[]; total: number };
    const today = new Date().toISOString().slice(0, 10);
    const items = page.data
      .map(deal)
      .sort((a, b) =>
        (a.expected_close_on ?? '').localeCompare(b.expected_close_on ?? ''),
      )
      .map((row) => ({
        ...row,
        past_expected_close:
          row.expected_close_on !== null && row.expected_close_on < today,
      }));
    return { days, total: page.total, items };
  }

  /**
   * Deals gone quiet (CD-65's stale alert) and deals whose follow-up date
   * has passed — the two ways a deal is forgotten.
   */
  async silentDeals(actor: Principal, query: SilentDealsQueryDto) {
    const ask = (follow_up: 'stale' | 'overdue') =>
      this.opportunities.list(actor, {
        page: 1,
        page_size: MAX_ROWS,
        follow_up,
        view: query.view,
      }) as Promise<{ data: DealRow[]; total: number }>;
    const [stale, overdue] = await Promise.all([ask('stale'), ask('overdue')]);
    return {
      silent: { total: stale.total, items: stale.data.map(deal) },
      follow_up_overdue: {
        total: overdue.total,
        items: overdue.data.map(deal),
      },
    };
  }

  /** What waits on the person's decision, covering included (APV-03). */
  async myApprovals(actor: Principal) {
    const page = (await this.approvals.inbox(actor, {
      page: 1,
      page_size: MAX_ROWS,
    })) as {
      data: {
        id: string;
        subjectType: string;
        amount: unknown;
        currency: string | null;
        currentStep: number;
        requestId: string | null;
        createdAt: Date;
      }[];
      total: number;
    };
    const requestIds = page.data.flatMap((row) => row.requestId ?? []);
    const requests = requestIds.length
      ? ((await this.requestRows.findMany({
          where: { id: { in: requestIds } },
          select: {
            id: true,
            requestNo: true,
            typeCode: true,
            formData: true,
          },
        })) as {
          id: string;
          requestNo: string | null;
          typeCode: string;
          formData: unknown;
        }[])
      : [];
    const byId = new Map(requests.map((row) => [row.id, row]));
    const now = Date.now();
    return {
      total: page.total,
      items: page.data.map((row) => {
        const request = row.requestId ? byId.get(row.requestId) : undefined;
        const subject = request
          ? this.subjectOf(
              actor,
              request.id,
              request.typeCode,
              request.formData,
            )
          : null;
        return {
          case_id: row.id,
          kind: row.subjectType,
          request_no: request?.requestNo ?? null,
          request_type: request?.typeCode ?? null,
          subject,
          amount: row.amount === null ? null : Number(row.amount),
          currency: row.currency,
          step: row.currentStep,
          waiting_days: Math.floor((now - row.createdAt.getTime()) / DAY_MS),
        };
      }),
    };
  }

  /** Running projects in red (or amber) health, the worst first. */
  async projectsAtRisk(actor: Principal, query: ProjectsAtRiskQueryDto) {
    const portfolio = await this.statusReports.portfolio(actor);
    const levels = query.level ? [query.level] : ['red', 'amber'];
    const items = portfolio.projects
      .filter((row) => levels.includes(row.health.level))
      .slice(0, MAX_ROWS)
      .map((row) => ({
        project_no: row.projectNo,
        name: row.name,
        customer: row.customerName,
        manager: row.managerName,
        health: row.health.level,
        why: row.health.factors,
        progress: row.progress,
        payments_overdue: row.paymentsOverdue,
        end_on: row.endOn,
        contract_value: row.contractValue,
      }));
    return { counts: portfolio.counts, items };
  }

  /** Open service jobs, each flagged when its SLA has run out. */
  async serviceJobs(actor: Principal, query: ServiceJobsQueryDto) {
    const jobs = await this.workOrders.list(actor, {
      customer_id: query.customer_id,
    });
    const ids = jobs.map((row) => row.requestId);
    const [late, types] = await Promise.all([
      this.lateRequests(ids),
      this.typesOf(ids),
    ]);
    const rows = jobs
      .map((row) => ({
        request_no: row.request?.requestNo ?? null,
        subject: this.subjectOf(
          actor,
          row.requestId,
          types.get(row.requestId),
          {
            subject: row.request?.subject ?? null,
          },
        ),
        status: row.request?.status ?? null,
        severity: row.request?.severity ?? null,
        customer: row.customer?.name ?? null,
        asset: row.asset?.name ?? null,
        work_kind: row.workKind,
        overdue: late.has(row.requestId),
      }))
      .filter((row) => query.overdue !== 'true' || row.overdue);
    return {
      total: rows.length,
      overdue: rows.filter((row) => row.overdue).length,
      items: rows.slice(0, MAX_ROWS),
    };
  }

  /** Published articles that answer a question, for staff. */
  async articles(actor: Principal, query: AssistantArticlesQueryDto) {
    const found = await this.kb.search(actor, {
      q: query.q,
      limit: query.limit ?? 5,
    });
    return {
      items: found.items.map((row) => ({
        article_no: row.articleNo,
        title: row.title,
        summary: row.summary,
        category: row.category?.name ?? null,
        tags: row.tags,
        score: row.score,
      })),
    };
  }

  /**
   * The person's own figures, counted live through the screens' scope —
   * a section the person has no screen for is left out, not zeroed.
   */
  async summary(actor: Principal) {
    const [requests, approvals, sales, closing, projects, service] =
      await Promise.all([
        has(actor, 'request.read') ? this.requestApi.summary(actor, {}) : null,
        has(actor, 'approval.decide')
          ? this.approvals
              .inbox(actor, { page: 1, page_size: 1 })
              .then((page) => ({ waiting: page.total }))
          : null,
        has(actor, 'crm.sales.read')
          ? this.crmDashboard.dashboard({ view: 'mine' } as never, actor)
          : null,
        has(actor, 'crm.sales.read')
          ? this.opportunities.list(actor, {
              page: 1,
              page_size: 1,
              closing_within_days: 30,
              view: 'mine',
            } as never)
          : null,
        this.statusReports.portfolio(actor).then((p) => p.counts),
        has(actor, 'service.asset.read')
          ? this.serviceJobs(actor, {}).then(({ total, overdue }) => ({
              open: total,
              overdue,
            }))
          : null,
      ]);
    return {
      requests,
      approvals,
      sales: sales
        ? {
            leads: sales.leads,
            opportunities: sales.opportunities,
            activities: sales.activities,
            closing_in_30_days: closing?.total ?? 0,
          }
        : null,
      projects,
      service,
    };
  }

  /**
   * A request's subject as this person may see it: through the request
   * type's masking rules (SCOPE-04), as the request screens show it. A type
   * that marks `subject` sensitive gets null, never the text.
   */
  private subjectOf(
    actor: Principal,
    id: string,
    typeCode: string | undefined,
    formData: unknown,
  ): string | null {
    const form = (formData ?? {}) as { subject?: unknown };
    if (typeof form.subject !== 'string') return null;
    const masked = this.masker.mask(
      'request:{typeCode}',
      { id, typeCode, form_data: { subject: form.subject } },
      actor,
    ) as { form_data?: { subject?: unknown } };
    const subject = masked.form_data?.subject;
    return typeof subject === 'string' ? subject : null;
  }

  private async typesOf(ids: string[]): Promise<Map<string, string>> {
    if (!ids.length) return new Map();
    const rows = (await this.requestRows.findMany({
      where: { id: { in: ids } },
      select: { id: true, typeCode: true },
    })) as { id: string; typeCode: string }[];
    return new Map(rows.map((row) => [row.id, row.typeCode]));
  }

  private async lateRequests(ids: string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const rows = (await this.requestRows.findMany({
      where: { id: { in: ids }, slaClock: { is: overdueClockWhere() } },
      select: { id: true },
    })) as { id: string }[];
    return new Set(rows.map((row) => row.id));
  }
}
