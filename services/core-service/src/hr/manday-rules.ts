/**
 * CD-233 — manday plan against actual, as pure arithmetic.
 *
 * The plan of a project is the labour in its latest locked budget (which
 * carries approved change requests); its split by HR level × work type comes
 * from the Solution version it was opened from (lines entered after CD-207
 * carry the codes). The actual is approved timesheet time, 8 hours a manday.
 * A person's plan is what they are booked for on the project (CD-232) on the
 * working days they are not on leave.
 */

import { HOURS_PER_MANDAY } from './timesheet-rules';

export const round2 = (value: number) => Math.round(value * 100) / 100;
export const toMandays = (hours: number) => round2(hours / HOURS_PER_MANDAY);

/** Labour mandays in a budget's lines (`category: labor`). */
export function budgetLaborMandays(lines: unknown): number {
  if (!Array.isArray(lines)) return 0;
  return round2(
    (lines as unknown[]).reduce<number>((sum, raw) => {
      const line = raw as { category?: string; quantity?: unknown };
      return line.category === 'labor'
        ? sum + (Number(line.quantity) || 0)
        : sum;
    }, 0),
  );
}

/** Mandays of a Solution's labour lines by `level|workType` code. */
export function solutionLaborByCode(labor: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (!Array.isArray(labor)) return out;
  for (const raw of labor) {
    const line = raw as {
      levelCode?: string;
      workTypeCode?: string;
      mandays?: unknown;
    };
    const key = codeKey(line.levelCode, line.workTypeCode);
    out.set(key, round2((out.get(key) ?? 0) + (Number(line.mandays) || 0)));
  }
  return out;
}

export function codeKey(level?: string | null, workType?: string | null) {
  return `${level ?? ''}|${workType ?? ''}`;
}

export interface BreakdownRow {
  levelCode: string | null;
  workTypeCode: string | null;
  planned: number;
  actual: number;
  variance: number;
  /** actual ÷ planned × 100; null without a plan. */
  percent: number | null;
}

/** Plan and actual side by side, one row per level × work type seen in either. */
export function compareBreakdown(
  planned: Map<string, number>,
  actual: Map<string, number>,
): BreakdownRow[] {
  const keys = [...new Set([...planned.keys(), ...actual.keys()])].sort();
  return keys.map((key) => {
    const [level, workType] = key.split('|');
    const plan = planned.get(key) ?? 0;
    const used = actual.get(key) ?? 0;
    return {
      levelCode: level || null,
      workTypeCode: workType || null,
      planned: round2(plan),
      actual: round2(used),
      variance: round2(used - plan),
      percent: percentOf(used, plan),
    };
  });
}

export function percentOf(actual: number, planned: number): number | null {
  return planned > 0 ? Math.round((actual / planned) * 100) : null;
}

/** "+16%" / "−8%" / "ไม่มีแผน". */
export function varianceLabel(actual: number, planned: number) {
  const percent = percentOf(actual, planned);
  if (percent === null) return 'ไม่มีแผน';
  const diff = percent - 100;
  return diff === 0 ? 'ตรงแผน' : `${diff > 0 ? '+' : '−'}${Math.abs(diff)}%`;
}

/** The steps reached and not yet sent — one notice per pass. */
export function stepsDue(
  percent: number | null,
  steps: readonly number[],
  sent: readonly number[],
) {
  if (percent === null) return [];
  return steps.filter((step) => percent >= step && !sent.includes(step));
}

/**
 * What a day of booking really plans: the booked hours, but no more than the
 * person has left after leave that day.
 */
export function plannedOnDay(day: {
  working: boolean;
  capacity: number;
  leaveHours: number;
  bookedHours: number;
}) {
  if (!day.working) return 0;
  return Math.max(0, Math.min(day.bookedHours, day.capacity - day.leaveHours));
}
