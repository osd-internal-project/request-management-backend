import { Injectable } from '@nestjs/common';
import {
  customerAccessSubject,
  salesAccessSubject,
  visibleCustomersWhere,
  visibleLeadsWhere,
  visibleSalesWhere,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import { CustomerRepository } from './customer.repository';
import { LeadStatusService } from './lead-status.service';
import { CrmDashboardQueryDto, OPEN_OPPORTUNITY_STAGES } from './dto/sales.dto';
import {
  LeadActivityRepository,
  LeadRepository,
  OpportunityActivityRepository,
  OpportunityRepository,
} from './sales.repositories';
import { resolvePeriod } from './sales-report.service';

const DAY_MS = 24 * 60 * 60 * 1000;
/** "ใกล้ถึงกำหนด" = ภายใน 7 วันข้างหน้า. */
const DUE_SOON_DAYS = 7;

type OpenStage = (typeof OPEN_OPPORTUNITY_STAGES)[number];

export interface CrmDashboard {
  view: 'mine' | 'team';
  /** ต้นเดือนนี้ (เวลาไทย) — ฐานของตัวเลข "เดือนนี้" ทุกตัว. */
  month_from: string;
  /** null = ผู้เรียกไม่มี `crm.customer.read` — ไม่ใช่ 0 ราย. */
  customers: { active: number; new_this_month: number } | null;
  leads: {
    open: number;
    new_this_month: number;
    by_status: { code: string; name: string; color: string; count: number }[];
  };
  opportunities: {
    open_count: number;
    open_amount: number;
    /** Σ amount × probability% — ดีลที่ไม่มีความน่าจะเป็นไม่ถูกนับ. */
    weighted_amount: number;
    /** ถูกเตือนว่าเงียบเกินเกณฑ์ (CD-65) และยังไม่มีกิจกรรมใหม่. */
    stale_count: number;
    won_this_month: { count: number; amount: number };
    by_stage: {
      stage: OpenStage;
      count: number;
      amount: number;
      weighted_amount: number;
    }[];
  };
  activities: {
    overdue: number;
    due_soon: number;
    completed_this_month: number;
  };
}

/**
 * CD-73 — แดชบอร์ด CRM: ลูกค้า Lead โอกาสการขาย และกิจกรรมในหน้าเดียว.
 *
 * "แยกมุมมองตามบทบาท" ได้มาจากกฎการมองเห็นชุดเดียวกับหน้ารายการ ไม่ได้เขียน
 * เงื่อนไขใหม่: พนักงานเห็นของตัวเอง หัวหน้าเห็นของทีม `*.read.all` เห็นทั้งบริษัท
 * (SCOPE-02 — ตัวเลขบนการ์ดต้องตรงกับแถวที่กดเข้าไปเห็น). `view=mine` แคบลงเหลือ
 * ของที่ตัวเองเป็นเจ้าของ ภายในขอบเขตนั้นเท่านั้น ไม่มีทางกว้างขึ้น.
 *
 * ตัวเลขสองแบบ แยกให้ชัดบนหน้าจอ:
 *   - **ภาพ ณ ตอนนี้** — ลูกค้า active, Lead เปิด, pipeline, กิจกรรมค้าง
 *   - **เดือนนี้** — ลูกค้า/Lead ใหม่, ชนะ, กิจกรรมที่ทำเสร็จ (ตามปฏิทินไทย)
 */
@Injectable()
export class CrmDashboardService {
  constructor(
    private readonly customers: CustomerRepository,
    private readonly leads: LeadRepository,
    private readonly leadStatuses: LeadStatusService,
    private readonly opportunities: OpportunityRepository,
    private readonly leadActivities: LeadActivityRepository,
    private readonly opportunityActivities: OpportunityActivityRepository,
  ) {}

  async dashboard(
    query: CrmDashboardQueryDto,
    actor: Principal,
    now: Date = new Date(),
  ): Promise<CrmDashboard> {
    const view = query.view ?? 'team';
    const mine = view === 'mine';
    const monthStart = resolvePeriod({}, now);
    const thisMonth = { gte: monthStart.start };

    const salesScope = {
      AND: [
        visibleSalesWhere(salesAccessSubject(actor)),
        mine ? { ownerUserId: actor.userId } : {},
      ],
    };
    // กองกลาง (ownerUserId NULL) นับใน "ทั้งหมด" แต่ไม่ใช่ "ของฉัน".
    const leadScope = {
      AND: [
        visibleLeadsWhere(salesAccessSubject(actor)),
        mine ? { ownerUserId: actor.userId } : {},
      ],
    };

    const [customers, leads, opportunities, activities] = await Promise.all([
      this.customerFigures(actor, mine, thisMonth),
      this.leadFigures(actor.activeCompanyId, leadScope, thisMonth),
      this.opportunityFigures(salesScope, thisMonth),
      this.activityFigures(leadScope, salesScope, now, thisMonth),
    ]);

    return {
      view,
      month_from: monthStart.from,
      customers,
      leads,
      opportunities,
      activities,
    };
  }

  private async customerFigures(
    actor: Principal,
    mine: boolean,
    thisMonth: { gte: Date },
  ): Promise<CrmDashboard['customers']> {
    // หน้านี้เปิดได้ด้วย crm.sales.read — ทะเบียนลูกค้าเป็นสิทธิ์อีกตัว.
    if (!actor.permissions.includes('crm.customer.read')) return null;

    const scope = {
      AND: [
        visibleCustomersWhere(customerAccessSubject(actor)),
        mine ? { accountOwnerUserId: actor.userId } : {},
      ],
    };
    const [active, newThisMonth] = await Promise.all([
      this.customers.count({ where: { ...scope, status: 'active' } }),
      this.customers.count({ where: { ...scope, createdAt: thisMonth } }),
    ]);
    return { active, new_this_month: newThisMonth };
  }

  private async leadFigures(
    companyId: string,
    scope: object,
    thisMonth: { gte: Date },
  ): Promise<CrmDashboard['leads']> {
    const [statuses, counts, newThisMonth] = await Promise.all([
      this.leadStatuses.listAll(companyId),
      this.leads.countByStatus(scope),
      this.leads.count({ where: { ...scope, createdAt: thisMonth } }),
    ]);

    const countOf = new Map(counts.map((row) => [row.status, row.count]));
    // ขั้นที่ยังเปิดตามลำดับที่ผู้ดูแลตั้ง — รวมขั้นที่ปิดใช้แล้วถ้ายังมี Lead ค้างอยู่.
    const byStatus = statuses
      .filter((status) => status.kind === 'open')
      .filter((status) => status.active || countOf.get(status.code))
      .map((status) => ({
        code: status.code,
        name: status.nameTh,
        color: status.color,
        count: countOf.get(status.code) ?? 0,
      }));

    return {
      open: byStatus.reduce((sum, row) => sum + row.count, 0),
      new_this_month: newThisMonth,
      by_status: byStatus,
    };
  }

  private async opportunityFigures(
    scope: object,
    thisMonth: { gte: Date },
  ): Promise<CrmDashboard['opportunities']> {
    const [open, won] = await Promise.all([
      this.opportunities.findMany({
        where: { ...scope, stage: { in: [...OPEN_OPPORTUNITY_STAGES] } },
        select: {
          stage: true,
          amount: true,
          probability: true,
          staleAlertedAt: true,
        },
      }) as Promise<
        {
          stage: OpenStage;
          amount: unknown;
          probability: number | null;
          staleAlertedAt: Date | null;
        }[]
      >,
      this.opportunities.totalsByOwner({
        ...scope,
        stage: 'won',
        wonAt: thisMonth,
      }),
    ]);

    const byStage = OPEN_OPPORTUNITY_STAGES.map((stage) => ({
      stage,
      count: 0,
      amount: 0,
      weighted_amount: 0,
    }));
    let staleCount = 0;

    for (const row of open) {
      const bucket = byStage.find((entry) => entry.stage === row.stage)!;
      const amount = row.amount === null ? 0 : Number(row.amount);
      bucket.count += 1;
      bucket.amount += amount;
      bucket.weighted_amount += (amount * (row.probability ?? 0)) / 100;
      if (row.staleAlertedAt) staleCount += 1;
    }

    const sum = (key: 'count' | 'amount' | 'weighted_amount') =>
      byStage.reduce((total, entry) => total + entry[key], 0);

    return {
      open_count: sum('count'),
      open_amount: sum('amount'),
      weighted_amount: Math.round(sum('weighted_amount') * 100) / 100,
      stale_count: staleCount,
      won_this_month: {
        count: won.reduce((total, group) => total + group.count, 0),
        amount: won.reduce((total, group) => total + group.amount, 0),
      },
      by_stage: byStage.map((entry) => ({
        ...entry,
        weighted_amount: Math.round(entry.weighted_amount * 100) / 100,
      })),
    };
  }

  /** กิจกรรมของ Lead และโอกาสการขายที่ผู้เรียกเห็นได้ — ขอบเขตตามแถวแม่. */
  private async activityFigures(
    leadScope: object,
    salesScope: object,
    now: Date,
    thisMonth: { gte: Date },
  ): Promise<CrmDashboard['activities']> {
    const soon = new Date(now.getTime() + DUE_SOON_DAYS * DAY_MS);
    const pending = { completedAt: null };

    const both = (where: object) =>
      Promise.all([
        this.leadActivities.count({ where: { ...where, lead: leadScope } }),
        this.opportunityActivities.count({
          where: { ...where, opportunity: salesScope },
        }),
      ]).then(([onLeads, onOpportunities]) => onLeads + onOpportunities);

    const [overdue, dueSoon, completed] = await Promise.all([
      both({ ...pending, dueAt: { lt: now } }),
      both({ ...pending, dueAt: { gte: now, lt: soon } }),
      both({ completedAt: thisMonth }),
    ]);

    return {
      overdue,
      due_soon: dueSoon,
      completed_this_month: completed,
    };
  }
}
