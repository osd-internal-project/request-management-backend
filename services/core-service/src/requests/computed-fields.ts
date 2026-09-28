import type { ErrorDetail } from '@request-management/share';

/**
 * CD-80 — a form field the system works out instead of the person typing it.
 *
 * Declared on the property as `x-computed`, so it stays configuration (REQ-01):
 *
 *   est_margin_pct: {
 *     type: 'number', title: 'margin คงเหลือ (%)',
 *     'x-computed': { kind: 'margin_pct', value: 'deal_value',
 *                     discount_pct: 'discount_pct', cost: 'cost' },
 *   }
 *
 * The server recomputes on every save and overwrites whatever arrived — a
 * number typed into the request body is exactly what this exists to stop
 * (a margin the requester made up is how a discount gets approved on a
 * figure nobody checked). The screen computes the same thing live so the
 * requester sees it before submitting; this is the authority.
 */
export interface MarginFormula {
  kind: 'margin_pct';
  /** The deal value before the discount. */
  value: string;
  /** % discount off `value`; absent = no discount. */
  discount_pct?: string;
  /** What delivering it costs. */
  cost: string;
}

export type ComputedFormula = MarginFormula;

type Properties = Record<string, { type?: string; 'x-computed'?: unknown }>;

function propertiesOf(schema: unknown): Properties {
  const properties = (schema as { properties?: unknown } | null)?.properties;
  return properties && typeof properties === 'object'
    ? (properties as Properties)
    : {};
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Remaining margin after the discount, as a percentage of the discounted
 * value, two decimals. Null when it cannot be known: an input is missing, or
 * nothing is left to sell (a 100% discount has no margin to express).
 */
export function marginPct(
  value: number | null,
  discountPct: number | null,
  cost: number | null,
): number | null {
  if (value === null || cost === null) return null;
  const net = value * (1 - (discountPct ?? 0) / 100);
  if (!(net > 0)) return null;
  return Math.round(((net - cost) / net) * 10_000) / 100;
}

function evaluate(
  formula: ComputedFormula,
  data: Record<string, unknown>,
): number | null {
  return marginPct(
    asNumber(data[formula.value]),
    formula.discount_pct ? asNumber(data[formula.discount_pct]) : 0,
    asNumber(data[formula.cost]),
  );
}

/**
 * The form data with every computed field worked out. A value that cannot be
 * computed is removed rather than kept — a stale margin from an earlier draft
 * must not survive its inputs being cleared.
 */
export function applyComputedFields(
  schema: unknown,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...data };
  for (const [name, property] of Object.entries(propertiesOf(schema))) {
    const formula = property['x-computed'] as ComputedFormula | undefined;
    if (!formula || formula.kind !== 'margin_pct') continue;
    const value = evaluate(formula, result);
    if (value === null) delete result[name];
    else result[name] = value;
  }
  return result;
}

/** For A2: a formula must name fields that exist and are numbers. */
export function computedFieldProblems(
  schema: unknown,
  path = 'form_schema.properties',
): ErrorDetail[] {
  const properties = propertiesOf(schema);
  const details: ErrorDetail[] = [];
  for (const [name, property] of Object.entries(properties)) {
    const formula = property['x-computed'] as
      Partial<MarginFormula> | undefined;
    if (formula === undefined) continue;
    const field = `${path}.${name}`;
    if (!formula || formula.kind !== 'margin_pct') {
      details.push({ field, reason: 'รู้จักเฉพาะสูตร margin_pct' });
      continue;
    }
    for (const input of ['value', 'cost', 'discount_pct'] as const) {
      const ref = formula[input];
      if (ref === undefined && input === 'discount_pct') continue;
      if (typeof ref !== 'string' || ref === name) {
        details.push({ field, reason: `สูตรต้องระบุฟิลด์ ${input}` });
      } else if (properties[ref]?.type !== 'number') {
        details.push({
          field,
          reason: `สูตรอ้างฟิลด์ "${ref}" ที่ไม่มีหรือไม่ใช่ตัวเลข`,
        });
      }
    }
  }
  return details;
}
