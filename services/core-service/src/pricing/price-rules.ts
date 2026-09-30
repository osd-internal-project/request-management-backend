/**
 * CD-194 — the rules of the standard price list, pure so they are tested on
 * their own. Dates are `YYYY-MM-DD` strings throughout: a price is valid for
 * whole days, `validTo` included, and an open `validTo` runs forever.
 */

export interface PriceRange {
  validFrom: string;
  validTo: string | null;
}

export type PriceStatus = 'current' | 'future' | 'expired';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY = /^[A-Z]{3}$/;
export const MAX_UNIT_PRICE = 999_999_999_999.99;
export const MAX_PRICE_NOTE = 500;

export const isIsoDate = (value: unknown): value is string =>
  typeof value === 'string' &&
  ISO_DATE.test(value) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

/** A Date column read back as its calendar day. */
export const dayOf = (value: Date | null): string | null =>
  value ? value.toISOString().slice(0, 10) : null;

/** Do two ranges share at least one day? */
export function overlaps(a: PriceRange, b: PriceRange): boolean {
  const aEnd = a.validTo ?? '9999-12-31';
  const bEnd = b.validTo ?? '9999-12-31';
  return a.validFrom <= bEnd && b.validFrom <= aEnd;
}

export function priceStatus(range: PriceRange, today: string): PriceStatus {
  if (range.validTo !== null && range.validTo < today) return 'expired';
  if (range.validFrom > today) return 'future';
  return 'current';
}

/** The price in effect on `on` — the ranges never overlap, so at most one. */
export function priceOn<T extends PriceRange>(
  rows: readonly T[],
  on: string,
): T | null {
  return rows.find((row) => priceStatus(row, on) === 'current') ?? null;
}

export interface PriceInput {
  productCode?: unknown;
  currency?: unknown;
  unitPrice?: unknown;
  validFrom?: unknown;
  validTo?: unknown;
  note?: unknown;
}

export interface CleanPrice {
  productCode: string;
  currency: string;
  unitPrice: number;
  validFrom: string;
  validTo: string | null;
  note: string;
}

/** What a save stores, or every problem with it at once. */
export function cleanPrice(
  input: PriceInput,
):
  | { ok: true; value: CleanPrice }
  | { ok: false; problems: { field: string; reason: string }[] } {
  const problems: { field: string; reason: string }[] = [];
  const productCode =
    typeof input.productCode === 'string' ? input.productCode.trim() : '';
  if (!productCode)
    problems.push({ field: 'product_code', reason: 'required' });

  const currency =
    typeof input.currency === 'string' && input.currency.trim()
      ? input.currency.trim().toUpperCase()
      : 'THB';
  if (!CURRENCY.test(currency)) {
    problems.push({ field: 'currency', reason: 'invalid' });
  }

  const unitPrice = input.unitPrice;
  if (
    typeof unitPrice !== 'number' ||
    !Number.isFinite(unitPrice) ||
    unitPrice < 0 ||
    unitPrice > MAX_UNIT_PRICE
  ) {
    problems.push({ field: 'unit_price', reason: 'invalid' });
  }

  if (!isIsoDate(input.validFrom)) {
    problems.push({ field: 'valid_from', reason: 'invalid_date' });
  }
  const validTo =
    input.validTo === null ||
    input.validTo === undefined ||
    input.validTo === ''
      ? null
      : input.validTo;
  if (validTo !== null && !isIsoDate(validTo)) {
    problems.push({ field: 'valid_to', reason: 'invalid_date' });
  } else if (
    validTo !== null &&
    isIsoDate(input.validFrom) &&
    validTo < input.validFrom
  ) {
    problems.push({ field: 'valid_to', reason: 'before_valid_from' });
  }

  const note = typeof input.note === 'string' ? input.note.trim() : '';
  if (note.length > MAX_PRICE_NOTE) {
    problems.push({ field: 'note', reason: 'too_long' });
  }

  if (problems.length) return { ok: false, problems };
  return {
    ok: true,
    value: {
      productCode,
      currency,
      unitPrice: Math.round((unitPrice as number) * 100) / 100,
      validFrom: input.validFrom as string,
      validTo: validTo as string | null,
      note,
    },
  };
}
