import { Injectable } from '@nestjs/common';
import {
  AppError,
  accessSubject,
  visibleRequestsWhere,
  PrismaService,
  resolveTargetCompany,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import type { Prisma, SlaState } from '@prisma/client';
import { slaStatusOf, type ClockFacts } from '../sla/sla-status';
import { SlaComplianceQueryDto } from './dto/report.dto';

const DAY_MS = 86_400_000;
const BANGKOK_OFFSET_MS = 7 * 3_600_000;
/** A period longer than this is a data export, not a report. */
const MAX_PERIOD_DAYS = 366;

export type SlaGroupBy = 'team' | 'type' | 'month';

export interface SlaComplianceRow {
  /** Team id, type code or `YYYY-MM`; null = requests with no receiving team. */
  key: string | null;
  label: string;
  /** Finished in the period (completed; cancelled work is not counted). */
  finished: number;
  on_time: number;
  late: number;
  /** on_time / finished, one decimal; null when nothing finished. */
  compliance_pct: number | null;
  /** Open now and past due — คำขอค้างเกินกำหนด. Null on month rows. */
  open_overdue: number | null;
  open_on_track: number | null;
  /** CD-67 cases whose first response fell in the period. */
  responses: number;
  responses_on_time: number;
  response_pct: number | null;
}

export interface SlaComplianceReport {
  from: string;
  to: string;
  group_by: SlaGroupBy;
  totals: SlaComplianceRow;
  rows: SlaComplianceRow[];
}

interface ClockRow {
  state: SlaState;
  responseBreachedAt?: Date | null;
  request: {
    typeCode: string;
    completedAt: Date | null;
    receiverOrgUnitId: string | null;
    requestType: { name: string } | null;
  };
}

const REQUEST_SELECT = {
  typeCode: true,
  completedAt: true,
  receiverOrgUnitId: true,
  requestType: { select: { name: true } },
} as const;

/**
 * CD-50 — สัดส่วนงานเสร็จตรงเวลา รายทีมผู้รับ ประเภทงาน หรือรายเดือน.
 *
 * Three questions, three populations, stated so nobody adds them up:
 * - **finished** — clocks stopped `met`/`breached` whose request completed in
 *   the period. The outcome was fixed at completion (`SlaService.stop`).
 * - **open** — everything still running or paused *now*, whatever the period:
 *   "ค้างเกินกำหนด" is a present-tense number. Month rows have none.
 * - **responses** — CD-67 cases first answered in the period.
 *
 * "Team" is the receiving team: the SLA is the receiver's promise, not the
 * requester's. Rows are limited to what the caller may open (SCOPE-02), as in
 * the bottleneck report.
 */
@Injectable()
export class SlaComplianceService {
  constructor(private readonly prisma: PrismaService) {}

  async report(
    query: SlaComplianceQueryDto,
    actor: Principal,
    now: Date = new Date(),
  ): Promise<SlaComplianceReport> {
    const companyId = resolveTargetCompany(actor, query.company_id);
    const groupBy: SlaGroupBy = query.group_by ?? 'team';
    const { from, to } = periodOf(query, now);

    const requestWhere: Prisma.RequestWhereInput = {
      companyId,
      ...(query.type_code ? { typeCode: query.type_code } : {}),
      ...(query.org_unit_id ? { receiverOrgUnitId: query.org_unit_id } : {}),
      ...this.visible(actor),
    };

    const [finished, open, responded] = await Promise.all([
      this.prisma.slaClock.findMany({
        where: {
          state: { in: ['met', 'breached'] },
          request: { ...requestWhere, completedAt: { gte: from, lte: to } },
        },
        select: { state: true, request: { select: REQUEST_SELECT } },
      }),
      groupBy === 'month'
        ? Promise.resolve([])
        : this.prisma.slaClock.findMany({
            where: {
              state: { in: ['running', 'paused'] },
              request: requestWhere,
            },
            select: {
              state: true,
              dueAt: true,
              breachedAt: true,
              request: { select: REQUEST_SELECT },
            },
          }),
      this.prisma.slaClock.findMany({
        where: {
          respondedAt: { gte: from, lte: to },
          responseDueAt: { not: null },
          request: requestWhere,
        },
        select: {
          state: true,
          responseBreachedAt: true,
          request: { select: REQUEST_SELECT },
        },
      }),
    ]);

    // `Request` carries the receiving team's id only — names come from the chart.
    const teamIds = [
      ...new Set(
        [...finished, ...open, ...responded]
          .map((clock) => clock.request.receiverOrgUnitId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const teamNames = new Map(
      groupBy === 'team' && teamIds.length
        ? (
            await this.prisma.orgUnit.findMany({
              where: { id: { in: teamIds } },
              select: { id: true, name: true },
            })
          ).map((unit) => [unit.id, unit.name] as const)
        : [],
    );

    const rows = new Map<string, SlaComplianceRow>();
    const totals = emptyRow(null, 'รวม', groupBy !== 'month');
    const rowOf = (clock: ClockRow) => {
      const [key, label] = groupOf(clock, groupBy, teamNames);
      const id = key ?? '';
      let row = rows.get(id);
      if (!row) {
        row = emptyRow(key, label, groupBy !== 'month');
        rows.set(id, row);
      }
      return row;
    };

    for (const clock of finished as ClockRow[]) {
      const onTime = clock.state === 'met';
      for (const row of [rowOf(clock), totals]) {
        row.finished += 1;
        if (onTime) row.on_time += 1;
        else row.late += 1;
      }
    }
    for (const clock of open as (ClockRow & ClockFacts)[]) {
      const late = slaStatusOf(clock, now) === 'overdue';
      for (const row of [rowOf(clock), totals]) {
        if (late) row.open_overdue = (row.open_overdue ?? 0) + 1;
        else row.open_on_track = (row.open_on_track ?? 0) + 1;
      }
    }
    for (const clock of responded as ClockRow[]) {
      // Month rows follow completion; a response belongs to its own month.
      const target = groupBy === 'month' ? null : rowOf(clock);
      for (const row of target ? [target, totals] : [totals]) {
        row.responses += 1;
        if (!clock.responseBreachedAt) row.responses_on_time += 1;
      }
    }

    const done = (row: SlaComplianceRow): SlaComplianceRow => ({
      ...row,
      compliance_pct: pct(row.on_time, row.finished),
      response_pct: pct(row.responses_on_time, row.responses),
    });

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      group_by: groupBy,
      totals: done(totals),
      rows: [...rows.values()].map(done).sort(order(groupBy)),
    };
  }

  /** SCOPE-02 — only requests the caller could open. */
  private visible(actor: Principal): Prisma.RequestWhereInput {
    const subject = accessSubject(actor);
    return subject.readsWholeCompany ? {} : visibleRequestsWhere(subject);
  }
}

/** Default: the last 30 days up to now. */
function periodOf(
  query: SlaComplianceQueryDto,
  now: Date,
): { from: Date; to: Date } {
  const to = query.to ? new Date(query.to) : now;
  const from = query.from
    ? new Date(query.from)
    : new Date(to.getTime() - 30 * DAY_MS);
  if (from > to) {
    throw new AppError(
      'VALIDATION_FAILED',
      'วันเริ่มต้องไม่อยู่หลังวันสิ้นสุด',
      [{ field: 'from', reason: 'after_to' }],
    );
  }
  if (to.getTime() - from.getTime() > MAX_PERIOD_DAYS * DAY_MS) {
    throw new AppError('VALIDATION_FAILED', 'ช่วงเวลายาวได้ไม่เกิน 1 ปี', [
      { field: 'to', reason: 'period_too_long' },
    ]);
  }
  return { from, to };
}

function groupOf(
  clock: ClockRow,
  groupBy: SlaGroupBy,
  teamNames: ReadonlyMap<string, string>,
): [string | null, string] {
  const request = clock.request;
  switch (groupBy) {
    case 'type':
      return [request.typeCode, request.requestType?.name ?? request.typeCode];
    case 'month': {
      const month = new Date(
        (request.completedAt as Date).getTime() + BANGKOK_OFFSET_MS,
      )
        .toISOString()
        .slice(0, 7);
      return [month, month];
    }
    default:
      return [
        request.receiverOrgUnitId,
        (request.receiverOrgUnitId &&
          teamNames.get(request.receiverOrgUnitId)) ||
          'ไม่ระบุทีมผู้รับ',
      ];
  }
}

function emptyRow(
  key: string | null,
  label: string,
  withOpen: boolean,
): SlaComplianceRow {
  return {
    key,
    label,
    finished: 0,
    on_time: 0,
    late: 0,
    compliance_pct: null,
    open_overdue: withOpen ? 0 : null,
    open_on_track: withOpen ? 0 : null,
    responses: 0,
    responses_on_time: 0,
    response_pct: null,
  };
}

function pct(part: number, whole: number): number | null {
  return whole ? Math.round((1000 * part) / whole) / 10 : null;
}

/** Months in order; otherwise the worst compliance first — that is the question. */
function order(groupBy: SlaGroupBy) {
  return (left: SlaComplianceRow, right: SlaComplianceRow) =>
    groupBy === 'month'
      ? (left.key ?? '').localeCompare(right.key ?? '')
      : (left.compliance_pct ?? 101) - (right.compliance_pct ?? 101) ||
        (right.open_overdue ?? 0) - (left.open_overdue ?? 0) ||
        left.label.localeCompare(right.label, 'th');
}
