/**
 * CD-179 งบอ้างอิง — the rules of the reference budget, apart from the
 * database: the first draft drawn from the baseline, what a line must say,
 * the totals, and what stops a draft from being locked.
 */

export const BUDGET_CATEGORIES = ['material', 'labor', 'other'] as const;
export type BudgetCategory = (typeof BUDGET_CATEGORIES)[number];
export const MAX_BUDGET_LINES = 500;

export interface BudgetLine {
  category: BudgetCategory;
  code: string | null;
  description: string;
  quantity: number;
  unit: string | null;
  /** Null while not yet known — a draft may have it, a locked budget not. */
  unitCost: number | null;
  amount: number;
}

const satang = (value: number) => Math.round(value * 100) / 100;

export function lineAmount(quantity: number, unitCost: number | null): number {
  return unitCost === null ? 0 : satang(quantity * unitCost);
}

interface BaselineLike {
  boq?: unknown;
  labor?: unknown;
  cost?: { lines?: unknown } | null;
}

/**
 * The first draft: every BOQ line at the cost the estimate gave it (a
 * partner quote, else the reference cost; null when neither), and every
 * labour line as man-days at its rate.
 */
export function draftFromBaseline(baseline: BaselineLike | null): BudgetLine[] {
  const boq = Array.isArray(baseline?.boq) ? baseline.boq : [];
  const costLines = Array.isArray(baseline?.cost?.lines)
    ? (baseline.cost.lines as { index?: number; unitCost?: number | null }[])
    : [];
  const lines: BudgetLine[] = boq.map((raw, index) => {
    const item = raw as {
      kind?: string;
      productCode?: string;
      name?: string;
      model?: string;
      quantity?: number;
      unit?: string;
      refUnitCost?: number | null;
    };
    const costed = costLines.find((line) => line.index === index);
    const unitCost =
      costed?.unitCost ??
      (typeof item.refUnitCost === 'number' ? item.refUnitCost : null);
    const quantity = Number(item.quantity) || 0;
    return {
      category: item.kind === 'service' ? 'other' : 'material',
      code: item.productCode || null,
      description: [item.name, item.model].filter(Boolean).join(' ') || '-',
      quantity,
      unit: item.unit || null,
      unitCost,
      amount: lineAmount(quantity, unitCost),
    };
  });
  const labor = Array.isArray(baseline?.labor) ? baseline.labor : [];
  for (const raw of labor) {
    const item = raw as { role?: string; mandays?: number; rate?: number };
    const quantity = Number(item.mandays) || 0;
    const unitCost = typeof item.rate === 'number' ? item.rate : null;
    lines.push({
      category: 'labor',
      code: null,
      description: item.role || '-',
      quantity,
      unit: 'man-day',
      unitCost,
      amount: lineAmount(quantity, unitCost),
    });
  }
  return lines;
}

/** Lines as saved: trimmed, amounts worked out; problems in Thai. */
export function cleanLines(
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
  if (input.length > MAX_BUDGET_LINES) {
    problems.push(`งบมีได้ไม่เกิน ${MAX_BUDGET_LINES} รายการ`);
  }
  const lines = input.slice(0, MAX_BUDGET_LINES).map((row, index) => {
    const n = `รายการที่ ${index + 1}`;
    const category = (BUDGET_CATEGORIES as readonly string[]).includes(
      row.category ?? '',
    )
      ? (row.category as BudgetCategory)
      : 'other';
    if (!row.description?.trim()) problems.push(`${n}: ต้องระบุรายการ`);
    const quantity = Number(row.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      problems.push(`${n}: จำนวนต้องมากกว่า 0`);
    }
    const unitCost =
      row.unit_cost === null || row.unit_cost === undefined
        ? null
        : Number(row.unit_cost);
    if (unitCost !== null && (!Number.isFinite(unitCost) || unitCost < 0)) {
      problems.push(`${n}: ต้นทุนต่อหน่วยต้องไม่ติดลบ`);
    }
    return {
      category,
      code: row.code?.trim() || null,
      description: row.description?.trim() ?? '',
      quantity: Number.isFinite(quantity) ? quantity : 0,
      unit: row.unit?.trim() || null,
      unitCost,
      amount: lineAmount(Number.isFinite(quantity) ? quantity : 0, unitCost),
    };
  });
  return { lines, problems };
}

/** What stops a draft from being locked, in Thai. */
export function lockProblems(lines: readonly BudgetLine[]): string[] {
  const problems: string[] = [];
  if (!lines.length) problems.push('งบยังไม่มีรายการ');
  const unknown = lines.filter((line) => line.unitCost === null).length;
  if (unknown) problems.push(`ยังมี ${unknown} รายการที่ไม่มีต้นทุน`);
  return problems;
}

/** Totals by category, the whole, and the margin against the contract value. */
export function budgetTotals(
  lines: readonly BudgetLine[],
  contractValue: number | null,
) {
  const byCategory = Object.fromEntries(
    BUDGET_CATEGORIES.map((category) => [
      category,
      satang(
        lines
          .filter((line) => line.category === category)
          .reduce((sum, line) => sum + line.amount, 0),
      ),
    ]),
  ) as Record<BudgetCategory, number>;
  const total = satang(lines.reduce((sum, line) => sum + line.amount, 0));
  const margin = contractValue === null ? null : satang(contractValue - total);
  return {
    byCategory,
    total,
    margin,
    marginPct:
      contractValue && margin !== null
        ? Math.round((margin / contractValue) * 1000) / 10
        : null,
    missingCost: lines.filter((line) => line.unitCost === null).length,
  };
}
