import { Injectable } from '@nestjs/common';
import { PrismaService } from '@request-management/share';
import type {
  Prisma,
  Request,
  RequestType,
  SlaClock,
  SlaCoverage,
} from '@prisma/client';
import {
  addWorkingMs,
  DEFAULT_CALENDAR,
  workingMsBetween,
  type WorkingCalendar,
} from './business-hours';

const HOUR_MS = 60 * 60 * 1000;

/**
 * SUP-01 — the SLA clock.
 *
 * Created paused at submit and **starts at the first assignment** (PO,
 * 25 Sep 2026): queue time before anyone owns the work is not counted. It
 * pauses on return and hold, and resumes when the work is picked up again. That pause is the whole reason this is a clock and
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

  /**
   * Creates the clock at submit, **paused**: the SLA counts from the first
   * assignment (`receive` or `assign`), which is when `resume` starts it.
   */
  async start(
    prisma: Prisma.TransactionClient,
    request: Request & { requestType: RequestType },
    at: Date,
  ): Promise<void> {
    const hours = await this.hoursFor(
      prisma,
      request.companyId,
      request.typeCode,
      request.requestType.slaHours,
    );

    if (hours === null) return;

    await prisma.slaClock.upsert({
      where: { requestId: request.id },
      update: {},
      // `dueAt` is a placeholder until `resume` computes it from the budget.
      create: {
        requestId: request.id,
        startedAt: at,
        pausedAt: at,
        dueAt: at,
        state: 'paused',
      },
    });

    await prisma.request.update({
      where: { id: request.id },
      data: { dueAt: null },
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

    const hours = await this.hoursFor(
      prisma,
      clock.request.companyId,
      clock.request.typeCode,
      clock.request.requestType.slaHours,
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
   * Ends the clock for good. `met`/`breached` is judged from the working time
   * actually used against the budget, so paused approval time never counts.
   */
  async stop(
    prisma: Prisma.TransactionClient,
    requestId: string,
    outcome: 'met' | 'cancelled' = 'met',
    at = new Date(),
  ): Promise<void> {
    const clock = await prisma.slaClock.findUnique({
      where: { requestId },
      include: { request: { include: { requestType: true } } },
    });
    if (!clock) return;

    if (outcome === 'cancelled') {
      await prisma.slaClock.update({
        where: { requestId },
        data: { state: 'cancelled', pausedAt: null },
      });
      return;
    }

    const { calendar, coverage } = await this.rulesFor(
      prisma,
      clock.request.companyId,
      clock.request.typeCode,
      clock.request.requestType.slaCoverage,
    );
    const ran =
      clock.state === 'running'
        ? Math.max(workingMsBetween(clock.startedAt, at, calendar, coverage), 0)
        : 0;
    const used = clock.accumulatedMs + ran;
    const hours = await this.hoursFor(
      prisma,
      clock.request.companyId,
      clock.request.typeCode,
      clock.request.requestType.slaHours,
    );
    const breached = hours === null ? at > clock.dueAt : used > hours * HOUR_MS;

    await prisma.slaClock.update({
      where: { requestId },
      data: {
        state: breached ? 'breached' : 'met',
        pausedAt: null,
        accumulatedMs: used,
        ...(breached && !clock.breachedAt ? { breachedAt: at } : {}),
      },
    });
  }

  /** Working time used as a % of the budget; null for a type with no SLA. */
  async percentUsed(
    prisma: Prisma.TransactionClient,
    clock: SlaClock & { request: Request & { requestType: RequestType } },
    at = new Date(),
  ): Promise<number | null> {
    const hours = await this.hoursFor(
      prisma,
      clock.request.companyId,
      clock.request.typeCode,
      clock.request.requestType.slaHours,
    );
    if (!hours) return null;

    const { calendar, coverage } = await this.rulesFor(
      prisma,
      clock.request.companyId,
      clock.request.typeCode,
      clock.request.requestType.slaCoverage,
    );
    const ran =
      clock.state === 'running'
        ? Math.max(workingMsBetween(clock.startedAt, at, calendar, coverage), 0)
        : 0;
    return ((clock.accumulatedMs + ran) / (hours * HOUR_MS)) * 100;
  }

  /** When an approval level with `hours` runs out, on the company's working calendar. */
  async dueAfter(
    prisma: Prisma.TransactionClient,
    companyId: string,
    typeCode: string | null,
    hours: number | null,
    at = new Date(),
  ): Promise<Date | null> {
    if (!hours) return null;
    const { calendar, coverage } = await this.rulesFor(
      prisma,
      companyId,
      typeCode ?? '',
      'H24X7',
    );
    return addWorkingMs(at, hours * HOUR_MS, calendar, coverage);
  }

  /**
   * D-09: hours from `SlaConfig` for this company and type, falling back to
   * the type's own default. `null` means this type has no SLA at all, which is
   * different from "zero hours".
   */
  private async hoursFor(
    prisma: Prisma.TransactionClient,
    companyId: string,
    typeCode: string,
    fallback: number | null,
  ): Promise<number | null> {
    const config = await prisma.slaConfig.findFirst({
      where: { companyId, requestTypeCode: typeCode },
    });

    return config?.hours ?? fallback;
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
