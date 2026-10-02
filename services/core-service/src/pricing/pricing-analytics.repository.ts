import { Injectable } from '@nestjs/common';
import { PrismaService } from '@request-management/share';

/** The sums every breakdown of the pricing mart reports. */
export interface MarginSums {
  key: string | null;
  quotations: number;
  gross: number;
  discount: number;
  net: number;
  cost: number;
  margin: number;
}

export interface AnalyticsFilter {
  companyCode: string;
  /** YYYY-MM, inclusive. */
  from: string | null;
  to: string | null;
  acceptedOnly: boolean;
}

/** The breakdowns the page shows; each is a column of the mart. */
export const BREAKDOWNS = {
  customer: 'customer_name',
  work_type: 'work_type',
  salesperson: 'owner_name',
  vendor: 'vendor_name',
  product_group: 'product_group',
} as const;
export type Breakdown = keyof typeof BREAKDOWNS;

const SUMS = `count(DISTINCT quotation_id)::int AS quotations,
  COALESCE(sum(gross), 0)::float8 AS gross,
  COALESCE(sum(discount_amount), 0)::float8 AS discount,
  COALESCE(sum(net), 0)::float8 AS net,
  COALESCE(sum(cost), 0)::float8 AS cost,
  COALESCE(sum(margin), 0)::float8 AS margin`;

/**
 * CD-208 — reads of `mart_pricing`. Every value reaches SQL as a parameter;
 * the only text spliced in is a column name from {@link BREAKDOWNS}.
 */
@Injectable()
export class PricingAnalyticsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async companyCode(companyId: string): Promise<string | null> {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { code: true },
    });
    return company?.code ?? null;
  }

  totals(filter: AnalyticsFilter) {
    return this.prisma
      .$queryRawUnsafe<MarginSums[]>(
        `SELECT NULL AS key, ${SUMS} FROM mart_pricing.fact_quotation_lines
         WHERE ${WHERE}`,
        ...params(filter),
      )
      .then((rows) => rows[0]);
  }

  by(filter: AnalyticsFilter, breakdown: Breakdown, limit: number) {
    const column = BREAKDOWNS[breakdown];
    return this.prisma.$queryRawUnsafe<MarginSums[]>(
      `SELECT ${column} AS key, ${SUMS} FROM mart_pricing.fact_quotation_lines
       WHERE ${WHERE}
       ${breakdown === 'vendor' ? `AND ${column} IS NOT NULL` : ''}
       GROUP BY ${column} ORDER BY sum(net) DESC NULLS LAST LIMIT ${Number(limit)}`,
      ...params(filter),
    );
  }

  monthly(filter: AnalyticsFilter) {
    return this.prisma.$queryRawUnsafe<MarginSums[]>(
      `SELECT approved_month AS key, ${SUMS} FROM mart_pricing.fact_quotation_lines
       WHERE ${WHERE}
       GROUP BY approved_month ORDER BY approved_month`,
      ...params(filter),
    );
  }

  exceptionsMonthly(filter: AnalyticsFilter) {
    return this.prisma.$queryRawUnsafe<
      { month: string; kind: string; decision: string; count: number }[]
    >(
      `SELECT recorded_month AS month, kind, decision, count(*)::int AS count
       FROM mart_pricing.fact_pricing_exceptions
       WHERE company_code = $1
         AND ($2::text IS NULL OR recorded_month >= $2)
         AND ($3::text IS NULL OR recorded_month <= $3)
       GROUP BY recorded_month, kind, decision
       ORDER BY recorded_month, kind`,
      filter.companyCode,
      filter.from,
      filter.to,
    );
  }

  async refreshedAt(): Promise<Date | null> {
    const [row] = await this.prisma.$queryRawUnsafe<{ refreshed_at: Date }[]>(
      `SELECT refreshed_at FROM mart.refresh_log
       WHERE table_name = 'pricing.fact_quotation_lines'`,
    );
    return row?.refreshed_at ?? null;
  }
}

const WHERE = `company_code = $1
  AND ($2::text IS NULL OR approved_month >= $2)
  AND ($3::text IS NULL OR approved_month <= $3)
  AND (NOT $4::boolean OR is_accepted)`;

function params(filter: AnalyticsFilter) {
  return [filter.companyCode, filter.from, filter.to, filter.acceptedOnly];
}
