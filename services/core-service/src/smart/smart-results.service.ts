import { Injectable } from '@nestjs/common';
import { AppError } from '@request-management/share';
import type { Principal } from '@request-management/share';
import {
  type FunnelRow,
  SmartResultsRepository,
} from './smart-results.repository';
import { SmartResultsQueryDto } from './smart.dto';

const rate = (top: number, bottom: number) =>
  bottom > 0 ? Math.round((top / bottom) * 1000) / 1000 : null;

/** A funnel row with its rates: reached of called, refused of reached, and onward. */
export function withRates(row: FunnelRow) {
  return {
    ...row,
    reach_rate: rate(row.reached, row.called),
    refusal_rate: rate(row.refused, row.reached),
    interest_rate: rate(row.interested, row.reached),
    deal_rate: rate(row.deal, row.swept),
    win_rate: rate(row.won, row.deal),
  };
}

/**
 * CD-295 (CD-16 AI SMART) — the results page: one funnel for what the
 * filters select, the same funnel split by source, sales axis, call list
 * (its script) and sweep month, and the calls made month by month. From the
 * Data Mart, as the executives' Metabase dashboards are — the figures agree.
 */
@Injectable()
export class SmartResultsService {
  constructor(private readonly results: SmartResultsRepository) {}

  async overview(actor: Principal, query: SmartResultsQueryDto) {
    const code = await this.results.companyCode(actor.activeCompanyId);
    if (!code) throw new AppError('NOT_FOUND', 'ไม่พบบริษัทที่ใช้งานอยู่');
    const filters = {
      sourceId: query.source_id ?? null,
      salesAxis: query.sales_axis ?? null,
      callListId: query.call_list_id ?? null,
      from: query.from ?? null,
      to: query.to ?? null,
    };
    const [total, bySource, byAxis, byList, byMonth, calls, refreshedAt] =
      await Promise.all([
        this.results.funnel(code, filters, null),
        this.results.funnel(code, filters, 'source'),
        this.results.funnel(code, filters, 'axis'),
        this.results.funnel(code, filters, 'list'),
        this.results.funnel(code, filters, 'month'),
        this.results.callMonths(code, filters),
        this.results.refreshedAt(),
      ]);
    return {
      refreshed_at: refreshedAt ? new Date(refreshedAt).toISOString() : null,
      total: withRates(
        total[0] ?? {
          key: null,
          label: null,
          swept: 0,
          screened: 0,
          called: 0,
          reached: 0,
          refused: 0,
          interested: 0,
          handed_off: 0,
          deal: 0,
          won: 0,
        },
      ),
      by_source: bySource.map(withRates),
      by_axis: byAxis.map(withRates),
      by_list: byList.map(withRates),
      by_month: byMonth.map(withRates),
      calls: calls.map((row) => ({
        ...row,
        reach_rate: rate(row.reached, row.calls),
        refusal_rate: rate(row.refused, row.reached),
      })),
    };
  }
}
