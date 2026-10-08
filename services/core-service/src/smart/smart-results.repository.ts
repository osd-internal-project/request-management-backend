import { Injectable } from '@nestjs/common';
import { PrismaService } from '@request-management/share';

export interface FunnelRow {
  key: string | null;
  label: string | null;
  swept: number;
  screened: number;
  called: number;
  reached: number;
  refused: number;
  interested: number;
  handed_off: number;
  deal: number;
  won: number;
}

export interface CallMonthRow {
  month: string;
  calls: number;
  reached: number;
  refused: number;
  interested: number;
}

export interface FunnelFilters {
  sourceId: string | null;
  salesAxis: string | null;
  callListId: string | null;
  from: string | null;
  to: string | null;
}

/** The dimensions a funnel may be split by, and the columns behind each. */
const GROUPS = {
  source: { key: 'source_id', label: 'max(source_name)' },
  axis: { key: 'sales_axis', label: 'sales_axis' },
  list: { key: 'call_list_id', label: 'max(call_list_name)' },
  month: { key: 'swept_month', label: 'swept_month' },
} as const;
export type FunnelGroup = keyof typeof GROUPS;

const COUNTS = `count(*)::int AS swept,
  count(*) FILTER (WHERE screened)::int AS screened,
  count(*) FILTER (WHERE called)::int AS called,
  count(*) FILTER (WHERE reached)::int AS reached,
  count(*) FILTER (WHERE refused)::int AS refused,
  count(*) FILTER (WHERE interested)::int AS interested,
  count(*) FILTER (WHERE handed_off)::int AS handed_off,
  count(*) FILTER (WHERE deal)::int AS deal,
  count(*) FILTER (WHERE won)::int AS won`;

/** Filters as SQL, every value a parameter ($2.. after the company code). */
const WHERE = `company_code = $1
  AND ($2::text IS NULL OR source_id = $2)
  AND ($3::text IS NULL OR sales_axis = $3)
  AND ($4::text IS NULL OR call_list_id = $4)
  AND ($5::text IS NULL OR swept_month >= $5)
  AND ($6::text IS NULL OR swept_month <= $6)`;

/**
 * CD-295 — reads of the AI SMART mart tables (`mart.fact_smart_prospects`,
 * `mart.fact_smart_calls`). A grouping is chosen from a fixed list; every
 * value reaches SQL as a parameter.
 */
@Injectable()
export class SmartResultsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async companyCode(companyId: string): Promise<string | null> {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { code: true },
    });
    return company?.code ?? null;
  }

  funnel(code: string, filters: FunnelFilters, group: FunnelGroup | null) {
    const by = group ? GROUPS[group] : null;
    return this.prisma.$queryRawUnsafe<FunnelRow[]>(
      `SELECT ${by ? `${by.key} AS key, ${by.label} AS label` : 'NULL AS key, NULL AS label'},
              ${COUNTS}
       FROM mart.fact_smart_prospects
       WHERE ${WHERE}
       ${by ? `GROUP BY ${by.key} ORDER BY ${group === 'month' ? 'key' : 'swept DESC'}` : ''}`,
      code,
      filters.sourceId,
      filters.salesAxis,
      filters.callListId,
      filters.from,
      filters.to,
    );
  }

  /** Calls by the month they were made (not the month the business was swept). */
  callMonths(code: string, filters: FunnelFilters) {
    return this.prisma.$queryRawUnsafe<CallMonthRow[]>(
      `SELECT k.month, count(*)::int AS calls,
              count(*) FILTER (WHERE k.reached)::int AS reached,
              count(*) FILTER (WHERE k.outcome = 'refused')::int AS refused,
              count(*) FILTER (WHERE k.outcome = 'interested')::int AS interested
       FROM mart.fact_smart_calls k
       WHERE k.company_code = $1
         AND ($2::text IS NULL OR EXISTS (
           SELECT 1 FROM mart.fact_smart_prospects p
           WHERE p.company_code = k.company_code
             AND p.source_id = $2 AND p.source_code = k.source_code))
         AND ($3::text IS NULL OR k.sales_axis = $3)
         AND ($4::text IS NULL OR k.list_id = $4)
         AND ($5::text IS NULL OR k.month >= $5)
         AND ($6::text IS NULL OR k.month <= $6)
       GROUP BY k.month ORDER BY k.month`,
      code,
      filters.sourceId,
      filters.salesAxis,
      filters.callListId,
      filters.from,
      filters.to,
    );
  }

  async refreshedAt(): Promise<Date | null> {
    const rows = await this.prisma.$queryRawUnsafe<{ refreshed_at: Date }[]>(
      `SELECT refreshed_at FROM mart.refresh_log WHERE table_name = 'fact_smart_prospects'`,
    );
    return rows[0]?.refreshed_at ?? null;
  }
}
