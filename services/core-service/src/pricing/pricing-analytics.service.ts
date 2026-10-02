import { Injectable } from '@nestjs/common';
import { AppError, type Principal } from '@request-management/share';
import {
  BREAKDOWNS,
  type Breakdown,
  type MarginSums,
  PricingAnalyticsRepository,
} from './pricing-analytics.repository';

const TOP = 20;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Sums with the two ratios a reader compares — in percent, 2 places. */
export function withRatios(row: MarginSums) {
  const pct = (part: number, whole: number) =>
    whole > 0 ? Math.round((part / whole) * 10_000) / 100 : null;
  return {
    ...row,
    margin_pct: pct(row.margin, row.net),
    discount_pct: pct(row.discount, row.gross),
  };
}

/**
 * CD-208 — วิเคราะห์ราคาและกำไร: margin and discount by customer, work type,
 * salesperson, cost vendor and product group, the monthly discount and
 * margin trend, and exceptions by month — over the pricing mart, for the
 * company in use. For Pricing (`pricing.price.read`): it is all margins.
 */
@Injectable()
export class PricingAnalyticsService {
  constructor(private readonly analytics: PricingAnalyticsRepository) {}

  async overview(
    actor: Principal,
    query: { from?: string; to?: string; accepted_only?: string },
  ) {
    for (const [field, value] of [
      ['from', query.from],
      ['to', query.to],
    ] as const) {
      if (value && !MONTH.test(value)) {
        throw new AppError('VALIDATION_FAILED', 'เดือนต้องเป็น YYYY-MM', [
          { field, reason: 'invalid_month' },
        ]);
      }
    }
    const companyCode = await this.analytics.companyCode(actor.activeCompanyId);
    if (!companyCode)
      throw new AppError('NOT_FOUND', 'ไม่พบบริษัทที่ทำงานอยู่');
    const filter = {
      companyCode,
      from: query.from ?? null,
      to: query.to ?? null,
      acceptedOnly: query.accepted_only === 'true',
    };

    const breakdowns = Object.keys(BREAKDOWNS) as Breakdown[];
    const [totals, monthly, exceptions, refreshedAt, ...groups] =
      await Promise.all([
        this.analytics.totals(filter),
        this.analytics.monthly(filter),
        this.analytics.exceptionsMonthly(filter),
        this.analytics.refreshedAt(),
        ...breakdowns.map((breakdown) =>
          this.analytics.by(filter, breakdown, TOP),
        ),
      ]);

    return {
      refreshed_at: refreshedAt,
      filter: {
        from: filter.from,
        to: filter.to,
        accepted_only: filter.acceptedOnly,
      },
      totals: withRatios(totals),
      monthly: monthly.map(withRatios),
      by: Object.fromEntries(
        breakdowns.map((breakdown, index) => [
          breakdown,
          groups[index].map(withRatios),
        ]),
      ),
      exceptions,
    };
  }
}
