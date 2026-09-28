import { Injectable } from '@nestjs/common';
import { PrismaService } from '@request-management/share';
import { Prisma } from '@prisma/client';
import type {
  Request,
  RequestSeverity,
  RequestType,
  SlaCoverage,
} from '@prisma/client';
import {
  addWorkingMs,
  DEFAULT_CALENDAR,
  workingMsBetween,
  type WorkingCalendar,
} from './business-hours';
import { readSeverityTargets, type SeverityTargets } from './severity';

const HOUR_MS = 60 * 60 * 1000;

/**
 * SUP-01 — the SLA clock.
 *
 * Starts at submit, **pauses when the request is returned**, and resumes when
 * it is submitted again. That pause is the whole reason this is a clock and
 * not a deadline stamped once: time the requester spends fixing their own
 * paperwork is not time the approver kept them waiting, and counting it makes
 * every bounced request look like an approver failure.
 *
 * Elapsed time is kept in `accumulatedMs` and `dueAt` is recomputed on each
 * resume, so a request returned three times still owes exactly the hours its
 * type allows.
 *
 * D-09: the hours are configuration, per company per type. Never hardcoded —
 * and since 31 Aug 2026 so is *which hours count*: `SlaCoverage` decides
 * whether the clock runs around the clock, only inside the office window, or
 * only inside it on working days. `business-hours.ts` does that arithmetic.
 */
@Injectable()
export class SlaService {
  constructor(private readonly prisma: PrismaService) {}

  /** Begins the clock at submit. */
  async start(
    prisma: Prisma.TransactionClient,
    request: Request & { requestType: RequestType },
    at: Date,
  ): Promise<void> {
    const { hours, responseHours } = await this.budgetFor(
      prisma,
      request.companyId,
      request.typeCode,
      request.requestType.slaHours,
      request.severity,
    );

    if (hours === null) return;

    const { calendar, coverage } = await this.rulesFor(
      prisma,
      request.companyId,
      request.typeCode,
      request.requestType.slaCoverage,
    );

    const dueAt = addWorkingMs(at, hours * HOUR_MS, calendar, coverage);
    // CD-67 — the response clock is set once, at the first submit, and is
    // not paused by a return: "has anyone picked this up?" does not wait on
    // the requester.
    const responseDueAt =
      responseHours === null
        ? null
        : addWorkingMs(at, responseHours * HOUR_MS, calendar, coverage);

    await prisma.slaClock.upsert({
      where: { requestId: request.id },
      update: {
        // A resubmit continues from the time already used rather than
        // restarting — see `resume`.
        state: 'running',
        pausedAt: null,
      },
      create: {
        requestId: request.id,
        startedAt: at,
        dueAt,
        state: 'running',
        responseDueAt,
      },
    });

    await prisma.request.update({
      where: { id: request.id },
      data: { dueAt },
    });
  }

  /** Stops the clock while the request is back with its requester. */
  async pause(
    prisma: Prisma.TransactionClient,
    requestId: string,
    at = new Date(),
  ): Promise<void> {
    const clock = await prisma.slaClock.findUnique({
      where: { requestId },
      include: { request: { include: { requestType: true } } },
    });
    if (!clock || clock.state !== 'running') return;

    const { calendar, coverage } = await this.rulesFor(
      prisma,
      clock.request.companyId,
      clock.request.typeCode,
      clock.request.requestType.slaCoverage,
    );

    // Working time, not wall time: a request that ran over a weekend under
    // `H8X5` has spent none of its budget, and charging it would make every
    // Friday ticket look slower than the same ticket raised on a Tuesday.
    const ran = workingMsBetween(clock.startedAt, at, calendar, coverage);

    await prisma.slaClock.update({
      where: { requestId },
      data: {
        state: 'paused',
        pausedAt: at,
        accumulatedMs: clock.accumulatedMs + Math.max(ran, 0),
      },
    });
  }

  /**
   * Resumes after a resubmit, with the budget it had left.
   *
   * Recomputed from `accumulatedMs` rather than shifted by the length of the
   * pause: under a working-hours coverage the two are different numbers, and
   * shifting by wall time would hand back the weekend as extra budget.
   */
  async resume(
    prisma: Prisma.TransactionClient,
    requestId: string,
    at = new Date(),
  ): Promise<void> {
    const clock = await prisma.slaClock.findUnique({
      where: { requestId },
      include: { request: { include: { requestType: true } } },
    });
    if (!clock || clock.state !== 'paused' || !clock.pausedAt) return;

    const { hours } = await this.budgetFor(
      prisma,
      clock.request.companyId,
      clock.request.typeCode,
      clock.request.requestType.slaHours,
      clock.request.severity,
    );

    if (hours === null) return;

    const { calendar, coverage } = await this.rulesFor(
      prisma,
      clock.request.companyId,
      clock.request.typeCode,
      clock.request.requestType.slaCoverage,
    );

    const remaining = Math.max(hours * HOUR_MS - clock.accumulatedMs, 0);
    const dueAt = addWorkingMs(at, remaining, calendar, coverage);

    await prisma.slaClock.update({
      where: { requestId },
      data: { state: 'running', pausedAt: null, startedAt: at, dueAt },
    });

    await prisma.request.update({ where: { id: requestId }, data: { dueAt } });
  }

  /**
   * Ends the clock for good.
   *
   * The final state records *why* it stopped: a request that finished inside
   * its window is `met`, one that had already run out is `breached`, and one
   * that was cancelled is `cancelled`. Collapsing all three into a single
   * "stopped" would make the SLA report unable to tell a success from a
   * failure after the fact.
   */
  async stop(
    prisma: Prisma.TransactionClient,
    requestId: string,
    outcome: 'met' | 'cancelled' = 'met',
    at = new Date(),
  ): Promise<void> {
    const clock = await prisma.slaClock.findUnique({ where: { requestId } });
    if (!clock) return;

    const breached = outcome === 'met' && at > clock.dueAt;

    await prisma.slaClock.update({
      where: { requestId },
      data: {
        state: breached ? 'breached' : outcome,
        pausedAt: null,
        ...(breached && !clock.breachedAt ? { breachedAt: at } : {}),
      },
    });
  }

  /**
   * CD-67 — the first sign of life from the receiving side: accepted,
   * assigned, or a comment by anyone but the requester. Only the first counts;
   * late is recorded as a breach even if the sweep has not run yet.
   */
  async markResponded(
    requestId: string,
    at = new Date(),
    prisma: Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    const clock = await prisma.slaClock.findUnique({ where: { requestId } });
    if (!clock?.responseDueAt || clock.respondedAt) return;

    await prisma.slaClock.update({
      where: { requestId },
      data: {
        respondedAt: at,
        ...(at > clock.responseDueAt && !clock.responseBreachedAt
          ? { responseBreachedAt: at }
          : {}),
      },
    });
  }

  /**
   * D-09: hours from `SlaConfig` for this company and type, falling back to
   * the type's own default. `null` means this type has no SLA at all, which is
   * different from "zero hours".
   *
   * CD-67: a type whose config carries severity targets is a case type — its
   * resolution budget and its response budget come from the request's
   * severity. A case submitted without one (only possible for rows older than
   * the rule) falls back to `hours` and gets no response clock.
   */
  private async budgetFor(
    prisma: Prisma.TransactionClient,
    companyId: string,
    typeCode: string,
    fallback: number | null,
    severity: RequestSeverity | null,
  ): Promise<{ hours: number | null; responseHours: number | null }> {
    const config = await prisma.slaConfig.findFirst({
      where: { companyId, requestTypeCode: typeCode },
    });

    const targets = readSeverityTargets(config?.severityTargets);
    if (targets && severity) {
      return {
        hours: targets[severity].resolutionHours,
        responseHours: targets[severity].responseHours,
      };
    }
    return { hours: config?.hours ?? fallback, responseHours: null };
  }

  /** CD-67 — every case type of a company with its targets, for the submit screen. */
  async caseTargetsOf(
    companyId: string,
  ): Promise<Map<string, SeverityTargets>> {
    const configs = await this.prisma.slaConfig.findMany({
      where: { companyId, NOT: { severityTargets: { equals: Prisma.DbNull } } },
      select: { requestTypeCode: true, severityTargets: true },
    });
    const result = new Map<string, SeverityTargets>();
    for (const config of configs) {
      const targets = readSeverityTargets(config.severityTargets);
      if (targets) result.set(config.requestTypeCode, targets);
    }
    return result;
  }

  /**
   * CD-67 — makes a type a case type in one company (targets), or stops it
   * being one (null). Written from A2 alongside the type, in its transaction.
   *
   * A company with no config row gets one: `hours` and `coverage` are copied
   * from the type so its flat clock — used only by a request with no severity,
   * i.e. none once this is a case type — reads the same as before. An existing
   * row takes the type's coverage too: the clock reads coverage from this row,
   * and the screen editing the targets is the one showing the type's coverage.
   *
   * Returns the targets it replaced, for the caller's audit entry.
   */
  async setSeverityTargets(
    prisma: Prisma.TransactionClient,
    companyId: string,
    type: { code: string; slaHours: number | null; slaCoverage: SlaCoverage },
    targets: SeverityTargets | null,
    actorId: string,
  ): Promise<SeverityTargets | null> {
    const before = await prisma.slaConfig.findFirst({
      where: { companyId, requestTypeCode: type.code },
      select: { severityTargets: true },
    });
    const previous = readSeverityTargets(before?.severityTargets);

    if (!targets) {
      if (previous) {
        await prisma.slaConfig.updateMany({
          where: { companyId, requestTypeCode: type.code },
          data: { severityTargets: Prisma.DbNull, updatedBy: actorId },
        });
      }
      return previous;
    }
    const json = targets as unknown as Prisma.InputJsonValue;
    await prisma.slaConfig.upsert({
      where: {
        companyId_requestTypeCode: { companyId, requestTypeCode: type.code },
      },
      create: {
        companyId,
        requestTypeCode: type.code,
        hours: type.slaHours ?? targets.low.resolutionHours,
        coverage: type.slaCoverage,
        severityTargets: json,
        updatedBy: actorId,
      },
      update: {
        coverage: type.slaCoverage,
        severityTargets: json,
        updatedBy: actorId,
      },
    });
    return previous;
  }

  /** CD-67 — whether this company treats the type as a case (severity required). */
  async isCaseType(
    companyId: string,
    typeCode: string,
    prisma: Prisma.TransactionClient = this.prisma,
  ): Promise<boolean> {
    const config = await prisma.slaConfig.findFirst({
      where: { companyId, requestTypeCode: typeCode },
      select: { severityTargets: true },
    });
    return readSeverityTargets(config?.severityTargets) !== null;
  }

  /**
   * The two things that decide *which* time counts: the company's working
   * window and the coverage this type is configured for.
   *
   * A company with no calendar row falls back to 08:30–17:30 Mon–Fri rather
   * than to "no window", because a missing calendar means nobody has set one
   * yet, not that the office never closes.
   */
  private async rulesFor(
    prisma: Prisma.TransactionClient,
    companyId: string,
    typeCode: string,
    fallback: SlaCoverage,
  ): Promise<{ calendar: WorkingCalendar; coverage: SlaCoverage }> {
    const [config, stored] = await Promise.all([
      prisma.slaConfig.findFirst({
        where: { companyId, requestTypeCode: typeCode },
      }),
      prisma.holidayCalendar.findUnique({ where: { companyId } }),
    ]);

    const calendar: WorkingCalendar = stored
      ? {
          workdayStartMinute: stored.workdayStartMinute,
          workdayEndMinute: stored.workdayEndMinute,
          workingWeekdays: stored.workingWeekdays,
          holidays: Array.isArray(stored.holidays)
            ? (stored.holidays as unknown[]).filter(
                (day): day is string => typeof day === 'string',
              )
            : [],
          timeZone: DEFAULT_CALENDAR.timeZone,
        }
      : DEFAULT_CALENDAR;

    return { calendar, coverage: config?.coverage ?? fallback };
  }
}
