import { Injectable } from '@nestjs/common';
import {
  AppError,
  salesAccessSubject,
  visibleSalesWhere,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import { CompanyMemberRepository } from '../access/company-member.repository';
import { OPEN_OPPORTUNITY_STAGES, SalesReportQueryDto } from './dto/sales.dto';
import {
  AmountGroup,
  OpportunityLostReasonRepository,
  OpportunityRepository,
  SaleOrderRepository,
} from './sales.repositories';

/** Thailand has no DST — a report day runs 00:00–24:00 +07:00. */
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** One year and a day — enough for "this year" in a leap year, no more. */
const MAX_RANGE_DAYS = 367;

export interface SalesReportPeriod {
  /** Inclusive, `YYYY-MM-DD` Bangkok. */
  from: string;
  /** Inclusive, `YYYY-MM-DD` Bangkok. */
  to: string;
  /** The instants the filters actually use: `[start, end)`. */
  start: Date;
  end: Date;
}

export interface SalesFigures {
  sales_amount: number;
  sale_order_count: number;
  won_count: number;
  won_amount: number;
  lost_count: number;
  lost_amount: number;
  /** won / (won + lost), 0–100 with one decimal; null when nothing closed. */
  win_rate: number | null;
  /** Snapshot now, not the period: deals still open. */
  open_count: number;
  open_amount: number;
}

export interface SalesReport {
  period: { from: string; to: string };
  totals: SalesFigures;
  lost_reasons: {
    code: string | null;
    name: string;
    count: number;
    amount: number;
  }[];
  by_owner: (SalesFigures & {
    owner_user_id: string;
    owner_name: string;
  })[];
}

/** `YYYY-MM-DD` of `instant` on the Bangkok calendar. */
function bangkokDate(instant: Date): string {
  return new Date(instant.getTime() + BANGKOK_OFFSET_MS)
    .toISOString()
    .slice(0, 10);
}

/** 00:00 Bangkok of a `YYYY-MM-DD`, as an instant. */
function bangkokMidnight(date: string): Date {
  return new Date(Date.parse(`${date}T00:00:00Z`) - BANGKOK_OFFSET_MS);
}

/**
 * The period a query asks for. Defaults to this month so far — the question
 * a sales manager opens the page with.
 */
export function resolvePeriod(
  query: Pick<SalesReportQueryDto, 'from' | 'to'>,
  now: Date = new Date(),
): SalesReportPeriod {
  const today = bangkokDate(now);
  const to = query.to ?? today;
  const from = query.from ?? `${today.slice(0, 8)}01`;

  const start = bangkokMidnight(from);
  const end = new Date(bangkokMidnight(to).getTime() + DAY_MS);

  // `Matches` lets `2026-02-31` through; Date rolls it into March silently.
  if (
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime()) ||
    bangkokDate(start) !== from ||
    bangkokDate(new Date(end.getTime() - DAY_MS)) !== to
  ) {
    throw new AppError('VALIDATION_FAILED', 'วันที่ไม่ถูกต้อง', [
      { field: 'from', reason: 'invalid_date' },
    ]);
  }
  if (end <= start) {
    throw new AppError('VALIDATION_FAILED', 'วันเริ่มต้องไม่เกินวันสิ้นสุด', [
      { field: 'from', reason: 'after_to' },
    ]);
  }
  if ((end.getTime() - start.getTime()) / DAY_MS > MAX_RANGE_DAYS) {
    throw new AppError('VALIDATION_FAILED', 'ช่วงรายงานยาวได้ไม่เกิน 1 ปี', [
      { field: 'from', reason: 'range_too_long' },
    ]);
  }

  return { from, to, start, end };
}

export function winRate(won: number, lost: number): number | null {
  const closed = won + lost;
  if (!closed) return null;
  return Math.round((won / closed) * 1000) / 10;
}

function emptyFigures(): SalesFigures {
  return {
    sales_amount: 0,
    sale_order_count: 0,
    won_count: 0,
    won_amount: 0,
    lost_count: 0,
    lost_amount: 0,
    win_rate: null,
    open_count: 0,
    open_amount: 0,
  };
}

/**
 * CD-83 — ยอดขาย อัตราการปิด วิเคราะห์แพ้ตามเหตุผล และผลงานรายบุคคล.
 *
 * ทุกตัวเลขผ่าน `visibleSalesWhere` เดียวกับหน้ารายการ: พนักงานเห็นของตัวเอง
 * หัวหน้าเห็นของหน่วยงานใต้ตัว `crm.sales.read.all` เห็นทั้งบริษัท — ตารางที่สั้นกว่า
 * ของเพื่อนร่วมงานคือความจริง ไม่ใช่ข้อผิดพลาด.
 *
 * นิยาม (ตั้งไว้ให้เทียบกับ SAP ได้):
 *   - **ยอดขาย** = ใบสั่งขายที่ไม่ถูกยกเลิก นับตาม `orderedAt` ในช่วง
 *   - **ชนะ / แพ้** = โอกาสการขายที่ `wonAt` / `lostAt` ตกในช่วง
 *   - **อัตราการปิด** = ชนะ ÷ (ชนะ + แพ้) ของช่วงนั้น
 *   - **ค้างใน pipeline** = โอกาสที่ยังเปิดอยู่ตอนนี้ ไม่ขึ้นกับช่วง
 *
 * ชนะไม่มีช่องเหตุผลในข้อมูล จึงวิเคราะห์ตามเหตุผลได้เฉพาะฝั่งแพ้.
 * ยอดทุกตัวรวมตามตัวเลขในใบ — ระบบยังออกเอกสารเป็น THB อย่างเดียว.
 */
@Injectable()
export class SalesReportService {
  constructor(
    private readonly opportunities: OpportunityRepository,
    private readonly saleOrders: SaleOrderRepository,
    private readonly lostReasons: OpportunityLostReasonRepository,
    private readonly members: CompanyMemberRepository,
  ) {}

  async report(
    query: SalesReportQueryDto,
    actor: Principal,
  ): Promise<SalesReport> {
    const period = resolvePeriod(query);
    const scope = {
      AND: [
        visibleSalesWhere(salesAccessSubject(actor)),
        query.owner_user_id ? { ownerUserId: query.owner_user_id } : {},
      ],
    };
    const inPeriod = { gte: period.start, lt: period.end };

    const [sales, won, lost, open, lostByReason] = await Promise.all([
      this.saleOrders.totalsByOwner({
        ...scope,
        status: 'open',
        orderedAt: inPeriod,
      }),
      this.opportunities.totalsByOwner({
        ...scope,
        stage: 'won',
        wonAt: inPeriod,
      }),
      this.opportunities.totalsByOwner({
        ...scope,
        stage: 'lost',
        lostAt: inPeriod,
      }),
      this.opportunities.totalsByOwner({
        ...scope,
        stage: { in: [...OPEN_OPPORTUNITY_STAGES] },
      }),
      this.opportunities.totalsByLostReason({
        ...scope,
        stage: 'lost',
        lostAt: inPeriod,
      }),
    ]);

    const owners = new Map<string, SalesFigures>();
    const fill = (
      groups: AmountGroup[],
      write: (figures: SalesFigures, group: AmountGroup) => void,
    ) => {
      for (const group of groups) {
        const ownerUserId = group.key as string; // NOT NULL column
        let figures = owners.get(ownerUserId);
        if (!figures) {
          figures = emptyFigures();
          owners.set(ownerUserId, figures);
        }
        write(figures, group);
      }
    };

    fill(sales, (figures, group) => {
      figures.sales_amount = group.amount;
      figures.sale_order_count = group.count;
    });
    fill(won, (figures, group) => {
      figures.won_amount = group.amount;
      figures.won_count = group.count;
    });
    fill(lost, (figures, group) => {
      figures.lost_amount = group.amount;
      figures.lost_count = group.count;
    });
    fill(open, (figures, group) => {
      figures.open_amount = group.amount;
      figures.open_count = group.count;
    });

    const totals = emptyFigures();
    for (const figures of owners.values()) {
      figures.win_rate = winRate(figures.won_count, figures.lost_count);
      totals.sales_amount += figures.sales_amount;
      totals.sale_order_count += figures.sale_order_count;
      totals.won_count += figures.won_count;
      totals.won_amount += figures.won_amount;
      totals.lost_count += figures.lost_count;
      totals.lost_amount += figures.lost_amount;
      totals.open_count += figures.open_count;
      totals.open_amount += figures.open_amount;
    }
    totals.win_rate = winRate(totals.won_count, totals.lost_count);

    const [names, reasonNames] = await Promise.all([
      this.displayNames([...owners.keys()]),
      this.reasonNames(actor.activeCompanyId),
    ]);

    return {
      period: { from: period.from, to: period.to },
      totals,
      lost_reasons: lostByReason
        .map((group) => ({
          code: group.key,
          name: group.key
            ? (reasonNames.get(group.key) ?? group.key)
            : 'ไม่ระบุเหตุผล',
          count: group.count,
          amount: group.amount,
        }))
        .sort((a, b) => b.count - a.count || b.amount - a.amount),
      by_owner: [...owners.entries()]
        .map(([ownerUserId, figures]) => ({
          owner_user_id: ownerUserId,
          owner_name: names.get(ownerUserId) ?? ownerUserId,
          ...figures,
        }))
        .sort(
          (a, b) =>
            b.sales_amount - a.sales_amount ||
            b.won_count - a.won_count ||
            a.owner_name.localeCompare(b.owner_name, 'th'),
        ),
    };
  }

  private async displayNames(ids: string[]) {
    if (!ids.length) return new Map<string, string>();

    const users = (await this.members.findMany({
      where: { id: { in: ids } },
      select: { id: true, displayName: true },
    })) as { id: string; displayName: string }[];

    return new Map(users.map((user) => [user.id, user.displayName]));
  }

  private async reasonNames(companyId: string) {
    const reasons = (await this.lostReasons.findMany({
      where: { companyId },
      select: { code: true, name: true },
    })) as { code: string; name: string }[];
    return new Map(reasons.map((reason) => [reason.code, reason.name]));
  }
}
