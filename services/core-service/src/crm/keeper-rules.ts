/**
 * CD-86 — แกน Keeper: the rules behind customer health and review cycles,
 * pure so each is tested alone. The data comes from what other modules
 * already keep (cases CD-67, overdue-invoice alerts CD-53, contracts CD-70,
 * contacts and reviews here); nothing is typed twice.
 *
 * Health is the worst of its signals (user decision 29 ก.ย. 2569: computed
 * signals plus the owner's satisfaction rating). Each signal carries a code
 * and its numbers; the screen words it.
 */

export type HealthLevel = 'green' | 'amber' | 'red';

export type HealthSignalCode =
  /** An open case past its response or resolution time. */
  | 'case_breached'
  /** An open critical/high case, still within time. */
  | 'case_serious'
  /** An overdue-invoice notice went out recently (CD-53 alerts). */
  | 'invoice_overdue'
  /** An active contract ends soon and no renewal deal is open. */
  | 'contract_ending'
  /** The renewal deal of an ending contract was lost. */
  | 'renewal_lost'
  /** The owner rated the customer low at the last review. */
  | 'low_satisfaction'
  /** Nobody has been in touch for too long. */
  | 'no_contact';

export interface HealthSignal {
  code: HealthSignalCode;
  level: Exclude<HealthLevel, 'green'>;
  /** The numbers the screen puts in its sentence. */
  values: Record<string, number | string>;
}

export interface HealthInput {
  /** null = the viewer may not read requests; the signal is not assessed. */
  cases: { breached: number; serious: number } | null;
  /** null = not assessed (no financial permission). */
  invoiceOverdue: { maxStep: number } | null;
  contracts: {
    /** Days to the nearest active contract end within the window. */
    endingInDays: number | null;
    renewalOpen: boolean;
    renewalLost: boolean;
  };
  /** Latest review rating, 1–5. */
  satisfaction: number | null;
  lastContactAt: Date | null;
  /** Customer created — "no contact" counts from here when never contacted. */
  since: Date;
}

export interface HealthConfig {
  /** No contact for longer than this = amber; twice this = red. */
  noContactDays: number;
}

/** A contract this close to its end with no renewal deal is a risk. */
export const CONTRACT_WINDOW_DAYS = 60;
/** Overdue notices older than this are not taken as current. */
export const INVOICE_ALERT_LOOKBACK_DAYS = 45;

const DAY_MS = 86_400_000;

export function assessHealth(
  input: HealthInput,
  config: HealthConfig,
  now: Date,
): { level: HealthLevel; signals: HealthSignal[] } {
  const signals: HealthSignal[] = [];

  if (input.cases?.breached) {
    signals.push({
      code: 'case_breached',
      level: 'red',
      values: { count: input.cases.breached },
    });
  } else if (input.cases?.serious) {
    signals.push({
      code: 'case_serious',
      level: 'amber',
      values: { count: input.cases.serious },
    });
  }

  if (input.invoiceOverdue) {
    signals.push({
      code: 'invoice_overdue',
      // 30 days past due is the second standard step — money that late is
      // a relationship problem, not a paperwork one.
      level: input.invoiceOverdue.maxStep >= 30 ? 'red' : 'amber',
      values: { days: input.invoiceOverdue.maxStep },
    });
  }

  if (input.contracts.renewalLost) {
    signals.push({ code: 'renewal_lost', level: 'red', values: {} });
  } else if (
    input.contracts.endingInDays !== null &&
    !input.contracts.renewalOpen
  ) {
    signals.push({
      code: 'contract_ending',
      level: 'amber',
      values: { days: input.contracts.endingInDays },
    });
  }

  if (input.satisfaction !== null && input.satisfaction <= 3) {
    signals.push({
      code: 'low_satisfaction',
      level: input.satisfaction <= 2 ? 'red' : 'amber',
      values: { score: input.satisfaction },
    });
  }

  if (config.noContactDays > 0) {
    const from = input.lastContactAt ?? input.since;
    const days = Math.floor((now.getTime() - from.getTime()) / DAY_MS);
    if (days > config.noContactDays) {
      signals.push({
        code: 'no_contact',
        level: days > config.noContactDays * 2 ? 'red' : 'amber',
        values: { days, never: input.lastContactAt ? 0 : 1 },
      });
    }
  }

  const level: HealthLevel = signals.some((s) => s.level === 'red')
    ? 'red'
    : signals.length
      ? 'amber'
      : 'green';
  return { level, signals };
}

/** The review after one done on `reviewedOn`, `months` later (same day). */
export function nextReviewAfter(reviewedOn: Date, months: number): Date {
  const next = new Date(reviewedOn);
  const day = next.getUTCDate();
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + months);
  // 31 Jan + 1 month = 28/29 Feb, not 3 Mar
  const last = new Date(
    Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0),
  ).getUTCDate();
  next.setUTCDate(Math.min(day, last));
  return next;
}

export const ACCOUNT_TIERS = ['a', 'b', 'c'] as const;
export const DEAL_TYPES = [
  'new_business',
  'upsell',
  'cross_sell',
  'renewal',
] as const;
/** Deal types that grow an existing account. */
export const EXPANSION_TYPES = ['upsell', 'cross_sell'] as const;
export const TOUCH_TYPES = [
  'review',
  'call',
  'email',
  'meeting',
  'visit',
  'line',
  'social',
] as const;
