/**
 * CD-206 — which supplier cost a product line takes, and whether it is too old
 * to price on. Pure; dates are YYYY-MM-DD strings (business days, Thai time).
 */

export interface VendorCostRow {
  productCode: string;
  vendorCode: string;
  vendorName: string | null;
  source: string;
  unitCost: number;
  currency: string;
  docNo: string | null;
  costDate: string;
  validTo: string | null;
}

/**
 * A cost somebody typed on the Pricing page — for a company with no ERP
 * connected yet, or a supplier's quote SAP does not hold. The sync never
 * writes this source, so it never overwrites one.
 */
export const MANUAL_SOURCE = 'manual';

export interface ManualCostInput {
  product_code?: unknown;
  vendor_code?: unknown;
  vendor_name?: unknown;
  unit_cost?: unknown;
  currency?: unknown;
  cost_date?: unknown;
  valid_to?: unknown;
  doc_no?: unknown;
}

export interface ManualCost {
  productCode: string;
  vendorCode: string;
  vendorName: string;
  unitCost: number;
  currency: string;
  costDate: string;
  validTo: string | null;
  docNo: string | null;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function isDay(value: string): boolean {
  return DAY.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

/**
 * Checks a typed-in cost. The supplier's code is optional — with no ERP there
 * is none — and falls back to the name. A cost dated after today is refused:
 * `bestVendorCost` would not use it, and the screen would show a cost no
 * quotation takes.
 */
export function cleanManualCost(
  input: ManualCostInput,
  today: string,
):
  | { ok: true; value: ManualCost }
  | { ok: false; problems: { field: string; reason: string }[] } {
  const text = (value: unknown) =>
    typeof value === 'string' ? value.trim() : '';
  const problems: { field: string; reason: string }[] = [];
  const productCode = text(input.product_code);
  const vendorName = text(input.vendor_name);
  const vendorCode = text(input.vendor_code) || vendorName;
  const currency = text(input.currency).toUpperCase() || 'THB';
  const costDate = text(input.cost_date);
  const validTo = text(input.valid_to) || null;
  const docNo = text(input.doc_no) || null;
  const unitCost =
    typeof input.unit_cost === 'number' ? input.unit_cost : Number.NaN;

  if (!productCode)
    problems.push({ field: 'product_code', reason: 'required' });
  if (!vendorName) problems.push({ field: 'vendor_name', reason: 'required' });
  if (!Number.isFinite(unitCost) || unitCost < 0)
    problems.push({ field: 'unit_cost', reason: 'not_negative_number' });
  if (!/^[A-Z]{3}$/.test(currency))
    problems.push({ field: 'currency', reason: 'three_letters' });
  if (!isDay(costDate)) problems.push({ field: 'cost_date', reason: 'date' });
  else if (costDate > today)
    problems.push({ field: 'cost_date', reason: 'not_after_today' });
  if (validTo && !isDay(validTo))
    problems.push({ field: 'valid_to', reason: 'date' });
  else if (validTo && isDay(costDate) && validTo < costDate)
    problems.push({ field: 'valid_to', reason: 'before_cost_date' });

  if (problems.length) return { ok: false, problems };
  return {
    ok: true,
    value: {
      productCode,
      vendorCode,
      vendorName,
      unitCost: Math.round(unitCost * 100) / 100,
      currency,
      costDate,
      validTo,
      docNo,
    },
  };
}

/** Today in Thailand (+07:00, no DST), as YYYY-MM-DD. */
export function thaiToday(now: Date = new Date()): string {
  return new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
}

/** Whole days from `date` to `today`. */
export function ageInDays(date: string, today: string): number {
  return Math.round(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) /
      86_400_000,
  );
}

/**
 * The cost a line takes: in the quotation's currency, a special price still
 * in effect or a purchase order — the most recent date wins; on the same day
 * a special price (an agreement) before an order.
 */
export function bestVendorCost<T extends VendorCostRow>(
  rows: readonly T[],
  currency: string,
  today: string,
): T | null {
  const usable = rows.filter(
    (row) =>
      row.currency === currency &&
      !(
        row.source !== 'purchase_order' &&
        row.validTo &&
        row.validTo < today
      ) &&
      row.costDate <= today,
  );
  return (
    usable.sort(
      (a, b) =>
        b.costDate.localeCompare(a.costDate) ||
        (a.source === 'special_price' ? -1 : 0) -
          (b.source === 'special_price' ? -1 : 0),
    )[0] ?? null
  );
}

/** Older than the company's limit — warned, never blocked. */
export function costIsStale(
  costDate: string,
  maxAgeDays: number,
  today: string,
): boolean {
  return ageInDays(costDate, today) > maxAgeDays;
}

/** What a line's cost source says: SAP's document, or that it was typed in. */
export function vendorCostSource(row: VendorCostRow): string {
  if (row.source === MANUAL_SOURCE) {
    return `กรอกเอง${row.docNo ? ` ${row.docNo}` : ''} · ${row.vendorName ?? row.vendorCode}`;
  }
  const doc =
    row.source === 'purchase_order'
      ? `ใบสั่งซื้อ ${row.docNo ?? ''}`.trim()
      : 'ราคาพิเศษผู้ขาย';
  return `SAP: ${doc} · ${row.vendorName ?? row.vendorCode}`;
}
