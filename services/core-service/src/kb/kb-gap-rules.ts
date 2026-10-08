/**
 * CD-266 ช่องว่างความรู้ (part of CD-22 KBMS) — when something is a gap,
 * apart from the database.
 */

/** CD-288 — ai_handed_off: AI answered, yet the conversation went to a person. */
export const GAP_KINDS = [
  'ai_unanswered',
  'ai_handed_off',
  'low_rated',
  'search_miss',
] as const;
export type GapKind = (typeof GAP_KINDS)[number];
export const GAP_STATUSES = [
  'open',
  'assigned',
  'resolved',
  'dismissed',
] as const;

export interface GapThresholds {
  minVotes: number;
  helpfulPercent: number;
  searchMisses: number;
  overdueDays: number;
}

export const DEFAULT_THRESHOLDS: GapThresholds = {
  minVotes: 5,
  helpfulPercent: 50,
  searchMisses: 3,
  overdueDays: 3,
};

/** The rule's parameters, else the standard. */
export function thresholdsOf(params: Record<string, unknown>): GapThresholds {
  const n = (key: string, fallback: number) =>
    typeof params[key] === 'number' ? params[key] : fallback;
  return {
    minVotes: n('min_votes', DEFAULT_THRESHOLDS.minVotes),
    helpfulPercent: n('helpful_percent', DEFAULT_THRESHOLDS.helpfulPercent),
    searchMisses: n('search_misses', DEFAULT_THRESHOLDS.searchMisses),
    overdueDays: n('overdue_days', DEFAULT_THRESHOLDS.overdueDays),
  };
}

/**
 * The same question asked twice is one gap: lower case, punctuation and
 * repeated spaces dropped (Thai stays as written).
 */
export function gapKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s\u200b]+/g, ' ')
    .replace(/[?!.,;:'"()[\]{}<>«»“”‘’…\-–—/\\|*_~`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/** Enough readers said it did not help. */
export function isLowRated(yes: number, no: number, t: GapThresholds): boolean {
  const total = yes + no;
  return total >= t.minVotes && (100 * yes) / total < t.helpfulPercent;
}

/** Days from `from` to `to` (YYYY-MM-DD). */
export function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      86_400_000,
  );
}

/** Time to remind the assignee: past due, and not reminded in `every` days. */
export function remindDue(
  dueOn: string | null,
  remindedOn: string | null,
  today: string,
  every: number,
): boolean {
  if (!dueOn || dueOn >= today) return false;
  return !remindedOn || daysBetween(remindedOn, today) >= every;
}

/** Self-answer rate: answered of those that reported an outcome. */
export function selfAnswerPct(
  answered: number,
  unanswered: number,
): number | null {
  const total = answered + unanswered;
  return total ? Math.round((1000 * answered) / total) / 10 : null;
}
