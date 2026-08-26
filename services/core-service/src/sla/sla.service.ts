import { Injectable } from '@nestjs/common';
import { PrismaService } from '@request-management/share';
import type { Prisma, Request, RequestType } from '@prisma/client';

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
 * D-09: the hours are configuration, per company per type. Never hardcoded.
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
    const hours = await this.hoursFor(
      prisma,
      request.companyId,
      request.typeCode,
      request.requestType.slaHours,
    );

    if (hours === null) return;

    const dueAt = new Date(at.getTime() + hours * HOUR_MS);

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
    const clock = await prisma.slaClock.findUnique({ where: { requestId } });
    if (!clock || clock.state !== 'running') return;

    const ran = at.getTime() - clock.startedAt.getTime();

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
   * Resumes after a resubmit, pushing `dueAt` out by however long it was
   * paused — so the request owes the same remaining hours it did before.
   */
  async resume(
    prisma: Prisma.TransactionClient,
    requestId: string,
    at = new Date(),
  ): Promise<void> {
    const clock = await prisma.slaClock.findUnique({ where: { requestId } });
    if (!clock || clock.state !== 'paused' || !clock.pausedAt) return;

    const pausedMs = at.getTime() - clock.pausedAt.getTime();
    const dueAt = new Date(clock.dueAt.getTime() + Math.max(pausedMs, 0));

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
}
