/**
 * CD-234 — labour cost: approved hours × the cost rate (per manday) of the
 * person's HR level and the line's work type in effect on the day worked
 * (CD-207). Hours with no level, or no rate that day, are counted apart as
 * unpriced rather than guessed — the same rule CD-190 costs projects by.
 */

import { rateOn, type RateRow } from './hr-rates';
import { HOURS_PER_MANDAY } from './timesheet-rules';

export const satang = (value: number) => Math.round(value * 100) / 100;

export interface CostableLine {
  levelId: string | null;
  workTypeId: string | null;
  date: string;
  hours: number;
}

export interface Rate extends RateRow {
  costPerManday: number;
}

export function priceLine<T extends CostableLine>(
  line: T,
  rates: readonly Rate[],
) {
  const rate =
    line.levelId && line.workTypeId
      ? rateOn(rates, line.levelId, line.workTypeId, line.date)
      : null;
  return {
    ...line,
    costPerManday: rate ? rate.costPerManday : null,
    cost: rate
      ? satang((line.hours / HOURS_PER_MANDAY) * rate.costPerManday)
      : null,
  };
}

export interface CostTotals {
  hours: number;
  mandays: number;
  cost: number;
  unpricedHours: number;
}

export function costTotals(
  lines: readonly { hours: number; cost: number | null }[],
): CostTotals {
  let hours = 0;
  let cost = 0;
  let unpriced = 0;
  for (const line of lines) {
    hours += line.hours;
    if (line.cost === null) unpriced += line.hours;
    else cost += line.cost;
  }
  return {
    hours: satang(hours),
    mandays: satang(hours / HOURS_PER_MANDAY),
    cost: satang(cost),
    unpricedHours: satang(unpriced),
  };
}

/** Lines grouped by a key, each group with its totals. */
export function groupCosts<T extends { hours: number; cost: number | null }>(
  lines: readonly T[],
  keyOf: (line: T) => string,
) {
  const groups = new Map<string, T[]>();
  for (const line of lines) {
    const key = keyOf(line);
    groups.set(key, [...(groups.get(key) ?? []), line]);
  }
  return [...groups.entries()].map(([key, rows]) => ({
    key,
    ...costTotals(rows),
  }));
}
