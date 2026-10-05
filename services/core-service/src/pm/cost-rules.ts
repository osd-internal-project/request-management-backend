/**
 * CD-190 ติดตามต้นทุนโครงการ — the rules, apart from the database: what
 * approved hours cost at the rate of their day, actual against the reference
 * budget per category, and which thresholds are newly crossed.
 */
import { rateOn } from '../hr/hr-rates';
import { BUDGET_CATEGORIES, BudgetCategory } from './budget-rules';

export const HOURS_PER_MANDAY = 8;
export const COST_ENTRY_CATEGORIES = ['material', 'other'] as const;
export type CostLevel = 'ok' | 'warn' | 'over';
export const DEFAULT_COST_WARN_PCT = 90;
export const DEFAULT_COST_ALERT_PCT = 100;

const satang = (value: number) => Math.round(value * 100) / 100;

export interface RateLike {
  levelId: string;
  workTypeId: string;
  validFrom: string;
  validTo: string | null;
  costPerManday: number;
}

/**
 * Approved hours at the cost rate of their own day, for the person's level
 * and the line's work type. Hours with no rate (no level, or no rate that
 * day) are counted apart, never guessed.
 */
export function laborCost(
  lines: readonly {
    levelId: string | null;
    workTypeId: string | null;
    date: string;
    hours: number;
  }[],
  rates: readonly RateLike[],
) {
  let amount = 0;
  let hours = 0;
  let unpricedHours = 0;
  for (const line of lines) {
    hours += line.hours;
    const rate =
      line.levelId && line.workTypeId
        ? rateOn(rates, line.levelId, line.workTypeId, line.date)
        : null;
    if (!rate) {
      unpricedHours += line.hours;
      continue;
    }
    amount += (line.hours / HOURS_PER_MANDAY) * rate.costPerManday;
  }
  return {
    amount: satang(amount),
    hours: satang(hours),
    mandays: satang(hours / HOURS_PER_MANDAY),
    unpricedHours: satang(unpricedHours),
  };
}

export interface CostRow {
  category: BudgetCategory | 'total';
  budget: number;
  actual: number;
  /** actual as % of budget; null with no budget */
  pct: number | null;
  level: CostLevel;
}

/** Actual against budget, per category and in total. */
export function compareCosts(input: {
  budget: Record<BudgetCategory, number>;
  actual: Record<BudgetCategory, number>;
  warnPct: number;
  alertPct: number;
}): CostRow[] {
  const row = (
    category: BudgetCategory | 'total',
    budget: number,
    actual: number,
  ): CostRow => {
    const pct = budget > 0 ? Math.round((actual / budget) * 1000) / 10 : null;
    // spending with nothing budgeted is over by definition
    const level: CostLevel =
      pct === null
        ? actual > 0
          ? 'over'
          : 'ok'
        : pct > input.alertPct
          ? 'over'
          : pct >= input.warnPct
            ? 'warn'
            : 'ok';
    return {
      category,
      budget: satang(budget),
      actual: satang(actual),
      pct,
      level,
    };
  };
  const rows = BUDGET_CATEGORIES.map((category) =>
    row(category, input.budget[category] ?? 0, input.actual[category] ?? 0),
  );
  rows.push(
    row(
      'total',
      rows.reduce((sum, item) => sum + item.budget, 0),
      rows.reduce((sum, item) => sum + item.actual, 0),
    ),
  );
  return rows;
}

/**
 * The alerts to send now: each level a row has reached that was not told
 * yet for this budget version (`over` also implies `warn`, told once).
 */
export function newCrossings(
  rows: readonly CostRow[],
  told: readonly { category: string; level: string }[],
): { category: CostRow['category']; level: 'warn' | 'over'; row: CostRow }[] {
  const seen = new Set(told.map((item) => `${item.category}:${item.level}`));
  return rows.flatMap((row) => {
    if (row.level === 'ok') return [];
    const level = row.level;
    if (seen.has(`${row.category}:${level}`)) return [];
    return [{ category: row.category, level, row }];
  });
}

/** A manual entry's own problems, in Thai. */
export function costEntryProblems(input: {
  category: string;
  description: string;
  amount: number;
  incurredOn: string;
  today: string;
  hasEvidence: boolean;
}): string[] {
  const problems: string[] = [];
  if (!(COST_ENTRY_CATEGORIES as readonly string[]).includes(input.category)) {
    problems.push(
      'หมวดต้องเป็นวัสดุ/อุปกรณ์ หรืออื่น ๆ (แรงงานมาจาก Timesheet)',
    );
  }
  if (!input.description.trim()) problems.push('ต้องระบุรายการ');
  if (input.description.length > 500)
    problems.push('รายการยาวเกิน 500 ตัวอักษร');
  if (!Number.isFinite(input.amount) || input.amount === 0) {
    problems.push('ต้องระบุจำนวนเงิน');
  }
  if (Math.abs(input.amount) >= 1e12) problems.push('จำนวนเงินมากเกินไป');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.incurredOn)) {
    problems.push('ต้องระบุวันที่เกิดค่าใช้จ่าย');
  } else if (input.incurredOn > input.today) {
    problems.push('วันที่เกิดค่าใช้จ่ายต้องไม่เกินวันนี้');
  }
  if (!input.hasEvidence) problems.push('ต้องแนบหลักฐาน');
  return problems;
}
