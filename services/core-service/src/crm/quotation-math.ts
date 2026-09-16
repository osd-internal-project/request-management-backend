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

export interface QuotationLineInput {
  quantity: number | string;
  unit_price: number | string;
  unit_cost?: number | string;
  discount_pct?: number | string;
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
    const quantity = new Decimal(line.quantity);
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
