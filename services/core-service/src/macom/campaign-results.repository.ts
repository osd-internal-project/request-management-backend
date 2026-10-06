import { Injectable } from '@nestjs/common';
import { PrismaService } from '@request-management/share';

export interface CampaignResultRow {
  campaign_id: string;
  campaign_code: string;
  campaign_name: string;
  kind: string;
  sales_axis: string | null;
  channel: string | null;
  start_date: Date | null;
  end_date: Date | null;
  active: boolean;
  budget: number | null;
  spent: number;
  leads: number;
  converted: number;
  won_deals: number;
  booked: number;
  invoiced: number;
  paid: number;
  cost_per_lead: number | null;
  cost_per_won_deal: number | null;
  roi_paid: number | null;
  roi_booked: number | null;
}

export interface MonthRow {
  month: string;
  spent: number;
  leads: number;
  won_deals: number;
  booked: number;
  invoiced: number;
  paid: number;
}

const MONTH_SUMS = `month,
  sum(spent)::float8 AS spent, sum(leads)::int AS leads,
  sum(won_deals)::int AS won_deals, sum(booked)::float8 AS booked,
  sum(invoiced)::float8 AS invoiced, sum(paid)::float8 AS paid`;

/**
 * CD-274 — reads of the campaign mart tables (`mart.fact_campaigns`,
 * `mart.fact_campaign_monthly`). Every value reaches SQL as a parameter.
 */
@Injectable()
export class CampaignResultsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async companyCode(companyId: string): Promise<string | null> {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { code: true },
    });
    return company?.code ?? null;
  }

  campaigns(companyCode: string) {
    return this.prisma.$queryRawUnsafe<CampaignResultRow[]>(
      `SELECT campaign_id, campaign_code, campaign_name, kind, sales_axis,
              channel, start_date, end_date, active,
              budget::float8 AS budget, spent::float8 AS spent, leads,
              converted, won_deals, booked::float8 AS booked,
              invoiced::float8 AS invoiced, paid::float8 AS paid,
              cost_per_lead::float8 AS cost_per_lead,
              cost_per_won_deal::float8 AS cost_per_won_deal,
              roi_paid::float8 AS roi_paid, roi_booked::float8 AS roi_booked
       FROM mart.fact_campaigns WHERE company_code = $1
       ORDER BY booked DESC, leads DESC, campaign_code`,
      companyCode,
    );
  }

  /** Every campaign together, by month, in a YYYY-MM range (inclusive). */
  months(companyCode: string, from: string | null, to: string | null) {
    return this.prisma.$queryRawUnsafe<MonthRow[]>(
      `SELECT ${MONTH_SUMS} FROM mart.fact_campaign_monthly
       WHERE company_code = $1
         AND ($2::text IS NULL OR month >= $2)
         AND ($3::text IS NULL OR month <= $3)
       GROUP BY month ORDER BY month`,
      companyCode,
      from,
      to,
    );
  }

  /** One campaign by month. */
  campaignMonths(companyCode: string, campaignId: string) {
    return this.prisma.$queryRawUnsafe<MonthRow[]>(
      `SELECT ${MONTH_SUMS} FROM mart.fact_campaign_monthly
       WHERE company_code = $1 AND campaign_id = $2
       GROUP BY month ORDER BY month`,
      companyCode,
      campaignId,
    );
  }

  async refreshedAt(): Promise<Date | null> {
    const rows = await this.prisma.$queryRawUnsafe<{ refreshed_at: Date }[]>(
      `SELECT refreshed_at FROM mart.refresh_log WHERE table_name = 'fact_campaigns'`,
    );
    return rows[0]?.refreshed_at ?? null;
  }
}
