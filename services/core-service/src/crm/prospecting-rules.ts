/**
 * CD-85 — แกน Getter: what the data means, kept pure so each rule is tested on
 * its own. Whether a lead *may* convert without full Discovery is process and
 * belongs to workflow `lwf-0001` (PO 10 ก.ย. 2569) — these only say what is
 * there and what is missing.
 */

/** The four things to know before a deal is opened (Discovery). */
export const DISCOVERY_ITEMS = [
  'need',
  'budget',
  'decision_maker',
  'timeframe',
] as const;
export type DiscoveryItem = (typeof DISCOVERY_ITEMS)[number];

export interface DiscoveryFields {
  discoveryNeed: string | null;
  discoveryBudget?: { toString(): string } | number | null;
  discoveryBudgetNote: string | null;
  discoveryDecisionMaker: string | null;
  discoveryTimeframe: Date | null;
}

const filled = (value: string | null | undefined) => Boolean(value?.trim());

/**
 * Items still unknown, in the order the screen lists them. A budget counts as
 * known with either a figure or a note ("ไม่เปิดเผย แต่อยู่ในงบปีหน้า" is an
 * answer; blank is not).
 */
export function discoveryMissing(lead: DiscoveryFields): DiscoveryItem[] {
  const missing: DiscoveryItem[] = [];
  if (!filled(lead.discoveryNeed)) missing.push('need');
  // `== null`: a row read without the column (undefined) is not a budget.
  if (lead.discoveryBudget == null && !filled(lead.discoveryBudgetNote))
    missing.push('budget');
  if (!filled(lead.discoveryDecisionMaker)) missing.push('decision_maker');
  if (!lead.discoveryTimeframe) missing.push('timeframe');
  return missing;
}

/**
 * Activity types that are an attempt to reach the prospect (Prospecting) —
 * a task or a note is not. A contact counts once it is done (`completedAt`).
 */
export const CONTACT_TYPES = [
  'call',
  'email',
  'meeting',
  'visit',
  'line',
  'social',
] as const;

export const ACTIVITY_OUTCOMES = [
  'reached',
  'no_answer',
  'interested',
  'not_interested',
] as const;
export type ActivityOutcomeCode = (typeof ACTIVITY_OUTCOMES)[number];

export const TARGET_PRIORITIES = ['high', 'medium', 'low'] as const;
export const TARGET_STATUSES = [
  'targeting',
  'approaching',
  'converted',
  'dropped',
] as const;
export type TargetStatus = (typeof TARGET_STATUSES)[number];

/**
 * A target moves forward only, and only by what happened to it: starting the
 * approach (a lead is made), its lead converting, or being dropped. A dropped
 * target can be taken up again — back to `targeting`, or to `approaching` when
 * it already has its lead.
 */
export function targetMayMove(from: TargetStatus, to: TargetStatus): boolean {
  const allowed: Record<TargetStatus, TargetStatus[]> = {
    targeting: ['approaching', 'dropped'],
    approaching: ['converted', 'dropped'],
    converted: [],
    dropped: ['targeting', 'approaching'],
  };
  return allowed[from].includes(to);
}
