import type { Logger } from '@nestjs/common';
import { ERP_SYSTEM } from '../erp/erp-client';
import { IntegrationSyncJobRepository } from './integration-job.repository';

/**
 * CM-06 / CD-88 — the retry mechanics every SAP sync shares. Each sync service
 * sweeps only its own `kind`s off `integration_sync_jobs`, so the customer
 * sweeper never picks up a sale-order row (or the other way round).
 */
export const ERP_MAX_ATTEMPTS = 10;

/** Backoff: 1m, 2m, 4m … capped at 30m — a down SAP is retried, not hammered. */
export function erpBackoffMs(attempts: number): number {
  return Math.min(60_000 * 2 ** attempts, 30 * 60_000);
}

export interface ErpJobRow {
  id: string;
  kind: string;
  resourceId: string;
  attempts: number;
}

/**
 * One pending row per (kind, resource): the sync always reads the latest state
 * of the resource, so stacking duplicates buys nothing.
 */
export async function enqueueErpJob(
  jobs: IntegrationSyncJobRepository,
  kind: string,
  resourceId: string,
  lastError: string,
): Promise<void> {
  const pending = (await jobs.findFirst({
    where: { system: ERP_SYSTEM, kind, resourceId, status: 'pending' },
    select: { id: true },
  })) as { id: string } | null;
  if (pending) return;

  await jobs.create({
    data: { system: ERP_SYSTEM, kind, resourceId, lastError },
  });
}

/**
 * Due rows of `kinds`, oldest first, one at a time — one bad row never drags
 * the whole pass down. `onFailure` sees every failed attempt; `exhausted` is
 * true on the last one, when the row is marked failed.
 */
export async function sweepErpJobs(
  jobs: IntegrationSyncJobRepository,
  kinds: readonly string[],
  handle: (job: ErpJobRow) => Promise<void>,
  logger: Logger,
  onFailure?: (
    job: ErpJobRow,
    error: string,
    exhausted: boolean,
  ) => Promise<void>,
): Promise<void> {
  const due = (await jobs.findMany({
    where: {
      system: ERP_SYSTEM,
      kind: { in: [...kinds] },
      status: 'pending',
      runAfter: { lte: new Date() },
    },
    orderBy: { createdAt: 'asc' },
    take: 20,
  })) as ErpJobRow[];

  for (const job of due) {
    try {
      await handle(job);
      await jobs.update({
        where: { id: job.id },
        data: { status: 'succeeded', attempts: job.attempts + 1 },
      });
    } catch (error) {
      const reason = errorMessage(error);
      const attempts = job.attempts + 1;
      const exhausted = attempts >= ERP_MAX_ATTEMPTS;
      await jobs.update({
        where: { id: job.id },
        data: {
          attempts,
          lastError: reason,
          status: exhausted ? 'failed' : 'pending',
          runAfter: new Date(Date.now() + erpBackoffMs(attempts)),
        },
      });
      if (exhausted) {
        logger.error(
          `sap job ${job.id} (${job.kind} ${job.resourceId}) gave up after ${attempts}: ${reason}`,
        );
      }
      await onFailure?.(job, reason, exhausted);
    }
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
