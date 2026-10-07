import { Injectable } from '@nestjs/common';
import { AppError } from '@request-management/share';
import type { Principal } from '@request-management/share';
import {
  CampaignResultsRepository,
  type CampaignResultRow,
  type MonthRow,
} from './campaign-results.repository';
import { CampaignResultsQueryDto } from './macom.dto';

const round2 = (value: number) => Math.round(value * 100) / 100;
const ratio = (top: number, bottom: number) =>
  bottom > 0 ? round2(top / bottom) : null;
const day = (value: Date | null) =>
  value ? new Date(value).toISOString().slice(0, 10) : null;

/** Totals over a set of campaigns, with the same ratios the mart gives one. */
export function sumResults(rows: readonly CampaignResultRow[]) {
  const sum = (key: keyof CampaignResultRow) =>
    round2(rows.reduce((total, row) => total + Number(row[key] ?? 0), 0));
  const spent = sum('spent');
  const leads = sum('leads');
  const won = sum('won_deals');
  const booked = sum('booked');
  const paid = sum('paid');
  return {
    campaigns: rows.length,
    budget: sum('budget'),
    spent,
    leads,
    converted: sum('converted'),
    won_deals: won,
    booked,
    invoiced: sum('invoiced'),
    paid,
    cost_per_lead: ratio(spent, leads),
    cost_per_won_deal: ratio(spent, won),
    roi_paid: ratio(paid, spent),
    roi_booked: ratio(booked, spent),
  };
}

/**
 * CD-274 — campaign results to real revenue, read from the Data Mart (rebuilt
 * hourly). A deal counts to the campaign of the Lead it came from; booked =
 * sale orders, invoiced/paid = its contracts' installments; set against
 * actual spend. For MACOM and the executives (`report.dashboard.read`):
 * company-wide money, not row-scoped.
 */
@Injectable()
export class CampaignResultsService {
  constructor(private readonly results: CampaignResultsRepository) {}

  async overview(actor: Principal, query: CampaignResultsQueryDto) {
    const code = await this.companyCode(actor);
    const [rows, months, refreshedAt] = await Promise.all([
      this.results.campaigns(code),
      this.results.months(code, query.from ?? null, query.to ?? null),
      this.results.refreshedAt(),
    ]);
    const shown = rows.filter(
      (row) =>
        (!query.kind || row.kind === query.kind) &&
        (!query.sales_axis || row.sales_axis === query.sales_axis),
    );
    return {
      refreshed_at: refreshedAt ? new Date(refreshedAt).toISOString() : null,
      totals: sumResults(shown),
      campaigns: shown.map((row) => ({
        ...row,
        start_date: day(row.start_date),
        end_date: day(row.end_date),
        conversion: ratio(row.won_deals, row.leads),
      })),
      months: months.map(this.month),
    };
  }

  async campaign(actor: Principal, campaignId: string) {
    const code = await this.companyCode(actor);
    const rows = await this.results.campaigns(code);
    const row = rows.find((r) => r.campaign_id === campaignId);
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบผลของแคมเปญนี้');
    return {
      campaign: {
        ...row,
        start_date: day(row.start_date),
        end_date: day(row.end_date),
      },
      months: (await this.results.campaignMonths(code, campaignId)).map(
        this.month,
      ),
    };
  }

  private month = (row: MonthRow) => ({
    month: row.month,
    spent: Number(row.spent),
    leads: Number(row.leads),
    won_deals: Number(row.won_deals),
    booked: Number(row.booked),
    invoiced: Number(row.invoiced),
    paid: Number(row.paid),
  });

  private async companyCode(actor: Principal) {
    const code = await this.results.companyCode(actor.activeCompanyId);
    if (!code) throw new AppError('NOT_FOUND', 'ไม่พบบริษัท');
    return code;
  }
}
