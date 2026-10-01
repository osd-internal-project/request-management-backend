import { Prisma } from '@prisma/client';

/**
 * CD-76 — the arithmetic of a quotation, pure and in decimals.
 *
 * Money never goes through JavaScript numbers here: `0.1 + 0.2` is how a
 * margin sits at 14.999999 against a 15% threshold and asks for an approval
 * nobody needed. Every stored amount is rounded half-up to 2 places, the same
 * precision as the columns it lands in.
 */

const Decimal = Prisma.Decimal;
type Decimal = Prisma.Decimal;

/** CD-196 — how a line's price is counted. */
export const PRICE_MODELS = ['unit', 'lump_sum', 'monthly'] as const;
export type PriceModel = (typeof PRICE_MODELS)[number];
export const MAX_TERM_MONTHS = 120;

export interface QuotationLineInput {
  quantity: number | string;
  unit_price: number | string;
  unit_cost?: number | string;
  discount_pct?: number | string;
  /** CD-196 — default `unit`. */
  price_model?: PriceModel;
  /** CD-196 — months of a `monthly` line. */
  term_months?: number | null;
}

/**
 * CD-196 — what the unit price is multiplied by: the quantity for a unit
 * price, 1 for a lump sum (the price is the whole job), the quantity times
 * the months for a monthly price. Cost follows the same count.
 */
export function billedQuantity(line: QuotationLineInput): Prisma.Decimal {
  if (line.price_model === 'lump_sum') return new Prisma.Decimal(1);
  const quantity = new Prisma.Decimal(line.quantity);
  return line.price_model === 'monthly'
    ? quantity.mul(line.term_months ?? 1)
    : quantity;
}

/** CD-196 — a monthly line needs its months; others must not carry any. */
export function priceModelProblems(
  lines: readonly QuotationLineInput[],
): { field: string; reason: string }[] {
  return lines.flatMap((line, index) => {
    const months = line.term_months;
    if (line.price_model === 'monthly') {
      return months !== null &&
        months !== undefined &&
        Number.isInteger(months) &&
        months >= 1 &&
        months <= MAX_TERM_MONTHS
        ? []
        : [{ field: `lines[${index}].term_months`, reason: 'required_1_120' }];
    }
    return [];
  });
}

export interface QuotationLineAmounts {
  lineTotal: Decimal;
  lineCost: Decimal;
}

export interface QuotationTotals {
  lines: QuotationLineAmounts[];
  subtotal: Decimal;
  discountTotal: Decimal;
  netTotal: Decimal;
  vatPct: Decimal;
  vatAmount: Decimal;
  grandTotal: Decimal;
  costTotal: Decimal;
  marginAmount: Decimal;
  /** null when there is no revenue to divide by. */
  marginPct: Decimal | null;
}

function money(value: Decimal): Decimal {
  return value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

export function computeQuotationTotals(
  lines: readonly QuotationLineInput[],
  vatPct: number | string,
): QuotationTotals {
  let subtotal = new Decimal(0);
  let netTotal = new Decimal(0);
  let costTotal = new Decimal(0);

  const amounts = lines.map((line) => {
    const quantity = billedQuantity(line);
    const gross = money(quantity.mul(line.unit_price));
    const discount = new Decimal(line.discount_pct ?? 0);
    const lineTotal = money(
      gross.mul(new Decimal(100).minus(discount)).div(100),
    );
    const lineCost = money(quantity.mul(line.unit_cost ?? 0));

    subtotal = subtotal.plus(gross);
    netTotal = netTotal.plus(lineTotal);
    costTotal = costTotal.plus(lineCost);

    return { lineTotal, lineCost };
  });

  const vat = new Decimal(vatPct);
  const vatAmount = money(netTotal.mul(vat).div(100));
  const marginAmount = netTotal.minus(costTotal);

  return {
    lines: amounts,
    subtotal,
    discountTotal: subtotal.minus(netTotal),
    netTotal,
    vatPct: vat,
    vatAmount,
    grandTotal: netTotal.plus(vatAmount),
    costTotal,
    marginAmount,
    marginPct: netTotal.gt(0)
      ? money(marginAmount.div(netTotal).mul(100))
      : null,
  };
}

/**
 * Does this margin need an approval before the quotation may go out?
 *
 * A quotation with no revenue cannot be judged against a percentage, so it is
 * sent for approval rather than waved through — "free" is exactly the offer a
 * margin check exists to catch.
 */
export function marginNeedsApproval(
  marginPct: Decimal | null,
  minMarginPct: number | string,
): boolean {
  if (marginPct === null) return true;
  return marginPct.lt(minMarginPct);
}

/** Thailand has no DST — the business day ends at 24:00 +07:00. */
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `validUntil` is a date (stored as 00:00 UTC of that calendar day). The
 * quotation is still good for the whole of that day in Bangkok, and expired
 * from the next midnight there.
 */
export function quotationExpired(validUntil: Date | null, now: Date): boolean {
  if (!validUntil) return false;
  const endOfDayBangkok = validUntil.getTime() + DAY_MS - BANGKOK_OFFSET_MS;
  return now.getTime() >= endOfDayBangkok;
}

/** Today in Bangkok + `days`, as a date at 00:00 UTC (the shape `validUntil` stores). */
export function defaultValidUntil(days: number, now: Date = new Date()): Date {
  const bangkok = new Date(now.getTime() + BANGKOK_OFFSET_MS);
  return new Date(
    Date.UTC(
      bangkok.getUTCFullYear(),
      bangkok.getUTCMonth(),
      bangkok.getUTCDate() + days,
    ),
  );
}

/** Overall discount the customer receives, as a % of the pre-discount total. */
export function overallDiscountPct(totals: QuotationTotals): Decimal {
  if (!totals.subtotal.gt(0)) return new Decimal(0);
  return money(totals.discountTotal.div(totals.subtotal).mul(100));
}

/**
 * CD-196 — the monthly charge of a quotation: each monthly line's amount
 * after discount, for one month. Shown beside the totals, which cover the
 * whole term.
 */
export function monthlyRecurring(
  lines: readonly {
    priceModel: string;
    termMonths: number | null;
    lineTotal: Prisma.Decimal | number | string;
  }[],
): Prisma.Decimal {
  return lines
    .filter((line) => line.priceModel === 'monthly' && line.termMonths)
    .reduce(
      (sum, line) =>
        sum.plus(money(new Decimal(line.lineTotal).div(line.termMonths!))),
      new Decimal(0),
    );
}

/** CD-199 — statuses in which a quotation still stands for its deal. */
const STANDING = ['draft', 'pending_approval', 'approved', 'sent', 'accepted'];

export interface DealQuotation {
  id: string;
  quotationNo: string;
  version: number;
  status: string;
  validUntil: Date | null;
  netTotal: Prisma.Decimal | number | string;
  costTotal: Prisma.Decimal | number | string;
}

/**
 * CD-199 — the deal's margin: for every quotation number its latest version
 * that still stands — not cancelled, declined or superseded, and not past
 * its validity unless the customer already accepted it. Revenue and cost
 * are summed in decimals; the percent is null with no revenue.
 */
export function dealMargin<T extends DealQuotation>(
  quotations: readonly T[],
  now: Date = new Date(),
) {
  const latest = new Map<string, T>();
  for (const row of quotations) {
    const seen = latest.get(row.quotationNo);
    if (!seen || row.version > seen.version) latest.set(row.quotationNo, row);
  }
  const counted = [...latest.values()].filter(
    (row) =>
      STANDING.includes(row.status) &&
      (row.status === 'accepted' || !quotationExpired(row.validUntil, now)),
  );
  const revenue = counted.reduce(
    (sum, row) => sum.plus(row.netTotal),
    new Decimal(0),
  );
  const cost = counted.reduce(
    (sum, row) => sum.plus(row.costTotal),
    new Decimal(0),
  );
  const margin = revenue.minus(cost);
  return {
    quotations: counted,
    netTotal: revenue,
    costTotal: cost,
    marginAmount: margin,
    marginPct: revenue.gt(0) ? money(margin.div(revenue).mul(100)) : null,
  };
}

/** CD-200 — work types, the same list as a Solution's BOQ kinds. */
export const WORK_TYPES = [
  'equipment',
  'material',
  'software',
  'service',
] as const;
export type WorkType = (typeof WORK_TYPES)[number];

/** CD-200 — the selling price markup gives a cost: cost × (1 + pct/100). */
export function markupPrice(unitCost: number, markupPct: number): number {
  return money(
    new Decimal(unitCost).mul(new Decimal(100).plus(markupPct)).div(100),
  ).toNumber();
}
