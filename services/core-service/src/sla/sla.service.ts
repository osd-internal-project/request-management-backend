import { Injectable } from '@nestjs/common';
import { PrismaService } from '@request-management/share';
import { Prisma } from '@prisma/client';
import type {
  Request,
  RequestSeverity,
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
import { readSeverityTargets, type SeverityTargets } from './severity';

const HOUR_MS = 60 * 60 * 1000;

/** What the clock needs to know about a request to pick its budget. */
interface ClockSubject {
  companyId: string;
  typeCode: string;
  severity: RequestSeverity | null;
  refType: string | null;
  refId: string | null;
  requestType: { slaHours: number | null; slaCoverage: SlaCoverage };
}

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
   * Creates the clock at submit. Paused for most types — the SLA counts from the
   * first assignment (D1), when `resume` starts it. A case type (CD-67) runs from
   * submit, and every type with a response target gets that clock now.
   */
  async start(
    prisma: Prisma.TransactionClient,
    request: Request & { requestType: RequestType },
    at: Date,
  ): Promise<void> {
    const { hours, responseHours } = await this.budgetFor(prisma, request);

    if (hours === null) return;

    const { calendar, coverage } = await this.rulesFor(prisma, request);

    // CD-67 — the response clock is set once, at the first submit, and is
    // not paused by a return: "has anyone picked this up?" does not wait on
    // the requester.
    const responseDueAt =
      responseHours === null
        ? null
        : addWorkingMs(at, responseHours * HOUR_MS, calendar, coverage);
    // A case type counts its resolution time from submit; the rest wait for D1.
    const runsFromSubmit = responseHours !== null;
    const dueAt = runsFromSubmit
      ? addWorkingMs(at, hours * HOUR_MS, calendar, coverage)
      : null;

    await prisma.slaClock.upsert({
      where: { requestId: request.id },
      update: {},
      create: {
        requestId: request.id,
        startedAt: at,
        responseDueAt,
        ...(dueAt
          ? { dueAt, state: 'running' }
          : // `dueAt` is a placeholder until `resume` computes it from the budget.
            { pausedAt: at, dueAt: at, state: 'paused' }),
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

    const { calendar, coverage } = await this.rulesFor(prisma, clock.request);

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

    const { hours } = await this.budgetFor(prisma, clock.request);

    if (hours === null) return;

    const { calendar, coverage } = await this.rulesFor(prisma, clock.request);

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

    const { calendar, coverage } = await this.rulesFor(prisma, clock.request);
    const ran =
      clock.state === 'running'
        ? Math.max(workingMsBetween(clock.startedAt, at, calendar, coverage), 0)
        : 0;
    const used = clock.accumulatedMs + ran;
    const { hours } = await this.budgetFor(prisma, clock.request);
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
    const { hours } = await this.budgetFor(prisma, clock.request);
    if (!hours) return null;

    const { calendar, coverage } = await this.rulesFor(prisma, clock.request);
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
    const { calendar, coverage } = await this.rulesFor(prisma, {
      companyId,
      typeCode: typeCode ?? '',
      severity: null,
      refType: null,
      refId: null,
      requestType: { slaHours: null, slaCoverage: 'H24X7' },
    });
    return addWorkingMs(at, hours * HOUR_MS, calendar, coverage);
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
    subject: ClockSubject,
  ): Promise<{ hours: number | null; responseHours: number | null }> {
    // CD-151 — a case raised against a contract with service levels is held
    // to the contract's targets, not the type's.
    const contracted = await this.contractLevels(prisma, subject);
    if (contracted && subject.severity) {
      return {
        hours: contracted.targets[subject.severity].resolutionHours,
        responseHours: contracted.targets[subject.severity].responseHours,
      };
    }
    const config = await prisma.slaConfig.findFirst({
      where: {
        companyId: subject.companyId,
        requestTypeCode: subject.typeCode,
      },
    });

    const targets = readSeverityTargets(config?.severityTargets);
    if (targets && subject.severity) {
      return {
        hours: targets[subject.severity].resolutionHours,
        responseHours: targets[subject.severity].responseHours,
      };
    }
    return {
      hours: config?.hours ?? subject.requestType.slaHours,
      responseHours: null,
    };
  }

  /**
   * CD-151 — the service levels a contract commits us to, when this request
   * is a case with a severity raised against that contract (by its number or
   * id, as CD-67 cases are). Null otherwise, or when the contract records no
   * levels.
   */
  private async contractLevels(
    prisma: Prisma.TransactionClient,
    subject: ClockSubject,
  ): Promise<{
    targets: SeverityTargets;
    coverage: SlaCoverage | null;
  } | null> {
    if (!subject.severity || subject.refType !== 'contract' || !subject.refId) {
      return null;
    }
    const contract = await prisma.customerContract.findFirst({
      where: {
        companyId: subject.companyId,
        OR: [{ contractNo: subject.refId }, { id: subject.refId }],
      },
      select: {
        terms: { select: { serviceLevels: true, serviceCoverage: true } },
      },
    });
    const targets = readSeverityTargets(contract?.terms?.serviceLevels);
    if (!targets) return null;
    return { targets, coverage: contract?.terms?.serviceCoverage ?? null };
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
    subject: ClockSubject,
  ): Promise<{ calendar: WorkingCalendar; coverage: SlaCoverage }> {
    const { companyId, typeCode } = subject;
    const [config, stored, contracted] = await Promise.all([
      prisma.slaConfig.findFirst({
        where: { companyId, requestTypeCode: typeCode },
      }),
      prisma.holidayCalendar.findUnique({ where: { companyId } }),
      this.contractLevels(prisma, subject),
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

    return {
      calendar,
      // CD-151 — the contract's coverage (24×7 support, office hours) first
      coverage:
        contracted?.coverage ??
        config?.coverage ??
        subject.requestType.slaCoverage,
    };
  }
}
