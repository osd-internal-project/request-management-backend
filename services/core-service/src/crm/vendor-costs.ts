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
      !(row.source === 'special_price' && row.validTo && row.validTo < today) &&
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

/** What a line's cost source says when the cost came from SAP. */
export function vendorCostSource(row: VendorCostRow): string {
  const doc =
    row.source === 'purchase_order'
      ? `ใบสั่งซื้อ ${row.docNo ?? ''}`.trim()
      : 'ราคาพิเศษผู้ขาย';
  return `SAP: ${doc} · ${row.vendorName ?? row.vendorCode}`;
}
