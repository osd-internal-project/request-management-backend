import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppError, Principal } from '@request-management/share';
import {
  HrEmployeeRepository,
  HrTimesheetLineRepository,
  HrWorkRefsRepository,
} from './hr.repositories';
import { HrRatesService } from './hr-rates.service';
import { LaborCostQueryDto } from './hr.dto';
import {
  type CostableLine,
  costTotals,
  groupCosts,
  priceLine,
} from './labor-cost';
import { isDay, spanDays } from './leave-rules';

const day = (value: Date) => value.toISOString().slice(0, 10);
const date = (value: string) => new Date(`${value}T00:00:00Z`);
/** A report covers at most a year. */
const MAX_REPORT_DAYS = 366;

export interface ServiceLine extends CostableLine {
  userId: string;
  requestId: string;
  billable: boolean;
}

interface StoredLine {
  workDate: Date;
  requestId: string | null;
  workTypeId: string;
  hours: Prisma.Decimal;
  billable: boolean;
  timesheet: { userId: string };
}

/**
 * CD-234 — labour cost (part of CD-17 HR).
 *
 * The one place hours become money: approved timesheet hours × the cost rate
 * of the person's level and the work type in effect that day (CD-207), with
 * hours that cannot be priced kept apart. Projects are costed by CD-190 with
 * the same rule; this prices service work — time logged against service
 * cases (requests) — for HR / finance reports, the pricing mart, and the
 * service margin of CD-21 (`forRequests`).
 *
 * Costs are pay-derived, so every route needs `hr.rate.read` (CD-207).
 */
@Injectable()
export class LaborCostService {
  constructor(
    private readonly lines: HrTimesheetLineRepository,
    private readonly employees: HrEmployeeRepository,
    private readonly refs: HrWorkRefsRepository,
    private readonly rates: HrRatesService,
  ) {}

  /** Price any lines of a company (for other modules). */
  async price<T extends CostableLine>(companyId: string, lines: readonly T[]) {
    const rates = await this.rates.rateRows(companyId);
    const priced = lines.map((line) => priceLine(line, rates));
    return { lines: priced, totals: costTotals(priced) };
  }

  /** Each request's labour so far — for CD-21's service margin. */
  async forRequests(companyId: string, requestIds: string[]) {
    if (!requestIds.length)
      return new Map<string, ReturnType<typeof costTotals>>();
    const { lines } = await this.price(
      companyId,
      await this.serviceLines(companyId, { requestIds }),
    );
    return new Map(
      groupCosts(lines, (line) => line.requestId).map(({ key, ...totals }) => [
        key,
        totals,
      ]),
    );
  }

  /** Service labour in a period, grouped by request, type, month or person. */
  async report(actor: Principal, query: LaborCostQueryDto) {
    const companyId = actor.activeCompanyId;
    period(query.from, query.to);
    const { lines, totals } = await this.price(
      companyId,
      await this.serviceLines(companyId, { from: query.from, to: query.to }),
    );
    const requests = await this.requestInfo(companyId, [
      ...new Set(lines.map((line) => line.requestId)),
    ]);
    const group = query.group ?? 'request';
    const keyOf = (line: (typeof lines)[number]) =>
      group === 'type'
        ? (requests.get(line.requestId)?.typeCode ?? '')
        : group === 'month'
          ? line.date.slice(0, 7)
          : group === 'person'
            ? line.userId
            : line.requestId;
    const rows = groupCosts(lines, keyOf);
    const names =
      group === 'person'
        ? await this.refs.names(rows.map((row) => row.key))
        : new Map<string, string>();
    const typeNames =
      group === 'type'
        ? await this.refs.requestTypeNames(rows.map((row) => row.key))
        : new Map<string, string>();
    return {
      from: query.from,
      to: query.to,
      group,
      totals,
      billableHours: lines
        .filter((line) => line.billable)
        .reduce((sum, line) => sum + line.hours, 0),
      rows: rows
        .map((row) => {
          const request =
            group === 'request' ? requests.get(row.key) : undefined;
          return {
            ...row,
            label:
              group === 'request'
                ? (request?.label ?? row.key)
                : group === 'type'
                  ? (typeNames.get(row.key) ?? row.key)
                  : group === 'person'
                    ? (names.get(row.key) ?? row.key)
                    : row.key,
            customer: request?.customer ?? null,
            status: request?.status ?? null,
          };
        })
        .sort((a, b) =>
          group === 'month' ? a.key.localeCompare(b.key) : b.cost - a.cost,
        ),
    };
  }

  /** One service case: every priced line, by person and day. */
  async request(actor: Principal, requestId: string) {
    const companyId = actor.activeCompanyId;
    const [info] = [
      ...(await this.requestInfo(companyId, [requestId])).values(),
    ];
    if (!info) throw new AppError('NOT_FOUND', 'ไม่พบคำขอที่ระบุ');
    const { lines, totals } = await this.price(
      companyId,
      await this.serviceLines(companyId, { requestIds: [requestId] }),
    );
    const [names, codes] = await Promise.all([
      this.refs.names([...new Set(lines.map((line) => line.userId))]),
      this.refs.hrCodes(companyId),
    ]);
    const level = new Map(codes.levels.map((l) => [l.id, l.name]));
    const workType = new Map(codes.workTypes.map((w) => [w.id, w.name]));
    return {
      request: info,
      totals,
      lines: lines
        .map((line) => ({
          ...line,
          name: names.get(line.userId) ?? line.userId,
          level: line.levelId ? (level.get(line.levelId) ?? null) : null,
          workType: line.workTypeId
            ? (workType.get(line.workTypeId) ?? null)
            : null,
        }))
        .sort((a, b) => a.date.localeCompare(b.date)),
    };
  }

  // --- helpers ----------------------------------------------------------------

  /** Approved time on service cases, with each person's current level. */
  private async serviceLines(
    companyId: string,
    filter: { from?: string; to?: string; requestIds?: string[] },
  ): Promise<ServiceLine[]> {
    const rows = (await this.lines.findMany({
      where: {
        kind: 'service',
        requestId: filter.requestIds
          ? { in: filter.requestIds }
          : { not: null },
        ...(filter.from && filter.to
          ? { workDate: { gte: date(filter.from), lte: date(filter.to) } }
          : {}),
        timesheet: { companyId, status: 'approved' },
      },
      select: {
        workDate: true,
        requestId: true,
        workTypeId: true,
        hours: true,
        billable: true,
        timesheet: { select: { userId: true } },
      },
    })) as unknown as StoredLine[];
    const userIds = [...new Set(rows.map((row) => row.timesheet.userId))];
    const levels = new Map(
      (
        (await this.employees.findMany({
          where: { companyId, userId: { in: userIds } },
          select: { userId: true, levelId: true },
        })) as { userId: string; levelId: string | null }[]
      ).map((row) => [row.userId, row.levelId]),
    );
    return rows.map((row) => ({
      userId: row.timesheet.userId,
      requestId: row.requestId!,
      levelId: levels.get(row.timesheet.userId) ?? null,
      workTypeId: row.workTypeId,
      date: day(row.workDate),
      hours: Number(row.hours),
      billable: row.billable,
    }));
  }

  private async requestInfo(companyId: string, ids: string[]) {
    if (!ids.length) return new Map<string, RequestInfo>();
    const rows = await this.refs.requestsByIds(companyId, ids);
    const types = await this.refs.requestTypeNames([
      ...new Set(rows.map((row) => row.typeCode)),
    ]);
    return new Map<string, RequestInfo>(
      rows.map((row) => [
        row.id,
        {
          id: row.id,
          requestNo: row.requestNo,
          typeCode: row.typeCode,
          typeName: types.get(row.typeCode) ?? row.typeCode,
          label: `${row.requestNo ?? 'ร่าง'} · ${types.get(row.typeCode) ?? row.typeCode}`,
          status: row.status,
          customer: row.contactCompany ?? null,
        },
      ]),
    );
  }
}

export interface RequestInfo {
  id: string;
  requestNo: string | null;
  typeCode: string;
  typeName: string;
  label: string;
  status: string;
  customer: string | null;
}

function period(from: string, to: string) {
  if (!isDay(from) || !isDay(to) || to < from) {
    throw new AppError('VALIDATION_FAILED', 'ช่วงวันที่ไม่ถูกต้อง');
  }
  if (spanDays(from, to) > MAX_REPORT_DAYS) {
    throw new AppError(
      'VALIDATION_FAILED',
      `ดูได้ครั้งละไม่เกิน ${MAX_REPORT_DAYS} วัน`,
    );
  }
}
