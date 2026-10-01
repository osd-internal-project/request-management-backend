/**
 * CD-185 คำขอเปลี่ยนแปลง — the rules of a change to what was sold, apart
 * from the database: what its cost lines may say, its effect on cost,
 * value and margin, what it must carry to go to the change board, and the
 * budget the approval writes.
 */
import {
  BUDGET_CATEGORIES,
  lineAmount,
  type BudgetCategory,
  type BudgetLine,
} from './budget-rules';

export const MAX_CHANGE_LINES = 200;
export const CHANGE_STATUSES = [
  'draft',
  'submitted',
  'approved',
  'rejected',
  'cancelled',
] as const;

const satang = (value: number) => Math.round(value * 100) / 100;

/**
 * Cost lines of a change: like budget lines, but a negative quantity takes
 * cost away (the scope removed). Every line needs its cost — a change is
 * judged on its numbers.
 */
export function cleanChangeLines(
  input: readonly {
    category?: string;
    code?: string | null;
    description?: string;
    quantity?: number;
    unit?: string | null;
    unit_cost?: number | null;
  }[],
): { lines: BudgetLine[]; problems: string[] } {
  const problems: string[] = [];
  if (input.length > MAX_CHANGE_LINES) {
    problems.push(`รายการต้นทุนมีได้ไม่เกิน ${MAX_CHANGE_LINES} รายการ`);
  }
  const lines = input.slice(0, MAX_CHANGE_LINES).map((row, index) => {
    const n = `รายการที่ ${index + 1}`;
    const category = (BUDGET_CATEGORIES as readonly string[]).includes(
      row.category ?? '',
    )
      ? (row.category as BudgetCategory)
      : 'other';
    if (!row.description?.trim()) problems.push(`${n}: ต้องระบุรายการ`);
    const quantity = Number(row.quantity);
    if (!Number.isFinite(quantity) || quantity === 0) {
      problems.push(`${n}: จำนวนต้องไม่เป็นศูนย์ (ติดลบ = ตัดออก)`);
    }
    const unitCost = Number(row.unit_cost);
    if (
      row.unit_cost === null ||
      row.unit_cost === undefined ||
      !Number.isFinite(unitCost) ||
      unitCost < 0
    ) {
      problems.push(`${n}: ต้องระบุต้นทุนต่อหน่วย`);
    }
    const qty = Number.isFinite(quantity) ? quantity : 0;
    const cost = Number.isFinite(unitCost) && unitCost >= 0 ? unitCost : null;
    return {
      category,
      code: row.code?.trim() || null,
      description: row.description?.trim() ?? '',
      quantity: qty,
      unit: row.unit?.trim() || null,
      unitCost: cost,
      amount: lineAmount(qty, cost),
    };
  });
  return { lines, problems };
}

export function costChangeOf(lines: readonly BudgetLine[]): number {
  return satang(lines.reduce((sum, line) => sum + line.amount, 0));
}

const marginOf = (value: number | null, cost: number | null) => {
  if (value === null || cost === null) return { amount: null, pct: null };
  const amount = satang(value - cost);
  return {
    amount,
    pct: value ? Math.round((amount / value) * 1000) / 10 : null,
  };
};

/**
 * The change against the budget in force: cost before and after, the
 * contract value before and after, and the margin both ways — "ระบบ
 * คำนวณ margin ใหม่ให้".
 */
export function changeImpact(
  current: { total: number | null; contractValue: number | null },
  costChange: number,
  priceChange: number,
) {
  const costTo =
    current.total === null ? null : satang(current.total + costChange);
  const valueTo =
    current.contractValue === null
      ? null
      : satang(current.contractValue + priceChange);
  const before = marginOf(current.contractValue, current.total);
  const after = marginOf(valueTo, costTo);
  return {
    cost: { from: current.total, to: costTo, change: costChange },
    value: { from: current.contractValue, to: valueTo, change: priceChange },
    margin: {
      from: before.amount,
      to: after.amount,
      fromPct: before.pct,
      toPct: after.pct,
    },
  };
}

/** What stops a change from going to the change board, in Thai. */
export function submitProblems(input: {
  title: string;
  reason: string;
  scopeAdded: string | null;
  scopeRemoved: string | null;
  scheduleDays: number;
  lines: number;
  priceChange: number;
  budgetLocked: boolean;
}): string[] {
  const problems: string[] = [];
  if (!input.title.trim()) problems.push('ต้องระบุเรื่อง');
  if (!input.reason.trim()) problems.push('ต้องระบุเหตุผลของการเปลี่ยนแปลง');
  if (
    !input.scopeAdded?.trim() &&
    !input.scopeRemoved?.trim() &&
    !input.scheduleDays &&
    !input.lines &&
    !input.priceChange
  ) {
    problems.push('ต้องระบุผลกระทบอย่างน้อยหนึ่งด้าน — ขอบเขต เวลา หรือต้นทุน');
  }
  if (input.lines && !input.budgetLocked) {
    problems.push(
      'โครงการยังไม่มีงบอ้างอิงที่ยืนยันแล้ว — ยืนยันงบก่อนจึงขอเปลี่ยนต้นทุนได้',
    );
  }
  return problems;
}

/** The budget an approved change leaves: the lines in force plus its own. */
export function budgetAfter(
  current: readonly BudgetLine[],
  change: readonly BudgetLine[],
  label: string,
): BudgetLine[] {
  return [
    ...current,
    ...change.map((line) => ({
      ...line,
      description: `${label}: ${line.description}`,
    })),
  ];
}
