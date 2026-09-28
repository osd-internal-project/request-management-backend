import type { SlaState } from '@prisma/client';

/**
 * CD-50 — where one request stands against its SLA. The one definition of
 * "คำขอค้างเกินกำหนด" (`overdue`): the SLA compliance report counts with it,
 * and the Metabase view `reporting.sla_clocks.sla_status` computes the same
 * thing in SQL (`SLA_STATUS_SQL` below, checked against
 * `infra/metabase/reporting.sql` by `sla-status.spec.ts`).
 *
 * - `on_time` / `late` — finished; decided when `SlaService.stop` runs, which is
 *   acceptance or close — `complete` only pauses the clock (B1)
 * - `overdue` — still open (running or paused) and past its deadline:
 *   either the sweep already recorded the breach, or it is running past due
 *   and the sweep has not got to it yet
 * - `on_track` — still open, not past due. A paused clock's `dueAt` is stale
 *   (it moves on resume), so a pause alone never makes a request overdue.
 * - `cancelled` — the work was withdrawn; counted nowhere.
 */
export type SlaStatus =
  'on_time' | 'late' | 'overdue' | 'on_track' | 'cancelled';

export interface ClockFacts {
  state: SlaState;
  dueAt: Date;
  breachedAt: Date | null;
}

export function slaStatusOf(clock: ClockFacts, now: Date): SlaStatus {
  switch (clock.state) {
    case 'met':
      return 'on_time';
    case 'breached':
      return 'late';
    case 'cancelled':
      return 'cancelled';
    default:
      return clock.breachedAt ||
        (clock.state === 'running' && clock.dueAt < now)
        ? 'overdue'
        : 'on_track';
  }
}

/**
 * The same rule in SQL over `sla_clocks sc`, as `reporting.sql` must spell it.
 * Whitespace-insensitive comparison; change both or the spec fails.
 */
export const SLA_STATUS_SQL = `
CASE
  WHEN sc.state = 'met'       THEN 'on_time'
  WHEN sc.state = 'breached'  THEN 'late'
  WHEN sc.state = 'cancelled' THEN 'cancelled'
  WHEN sc."breachedAt" IS NOT NULL
    OR (sc.state = 'running' AND sc."dueAt" < now()) THEN 'overdue'
  ELSE 'on_track'
END`;
