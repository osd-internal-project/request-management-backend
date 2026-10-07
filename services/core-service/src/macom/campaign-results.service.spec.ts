import type { Principal } from '@request-management/share';
import { CampaignResultsService, sumResults } from './campaign-results.service';
import { CAMPAIGN_MART_TABLES } from '../bi/campaign-mart';

const actor = {
  userId: 'u-mkt',
  activeCompanyId: 'osd',
  permissions: ['crm.campaign.manage'],
} as unknown as Principal;

const row = (overrides: Record<string, unknown> = {}) => ({
  campaign_id: 'cmp-1',
  campaign_code: 'EXPO',
  campaign_name: 'งาน Expo',
  kind: 'event',
  sales_axis: 'getter',
  channel: 'อีเวนต์',
  start_date: new Date('2026-10-01T00:00:00Z'),
  end_date: null,
  active: true,
  budget: 100_000,
  spent: 80_000,
  leads: 40,
  converted: 10,
  won_deals: 4,
  booked: 600_000,
  invoiced: 300_000,
  paid: 200_000,
  cost_per_lead: 2000,
  cost_per_won_deal: 20_000,
  roi_paid: 2.5,
  roi_booked: 7.5,
  ...overrides,
});

describe('CD-274 campaign results to revenue', () => {
  it('totals carry the same ratios as one campaign, from summed money', () => {
    expect(
      sumResults([
        row(),
        row({
          campaign_id: 'cmp-2',
          spent: 20_000,
          leads: 10,
          won_deals: 1,
          booked: 0,
          invoiced: 0,
          paid: 0,
        }) as never,
      ] as never),
    ).toMatchObject({
      campaigns: 2,
      spent: 100_000,
      leads: 50,
      won_deals: 5,
      booked: 600_000,
      paid: 200_000,
      cost_per_lead: 2000,
      cost_per_won_deal: 20_000,
      roi_paid: 2,
      roi_booked: 6,
    });
    // no spend → no ratio, not infinity
    expect(sumResults([row({ spent: 0 })] as never).roi_paid).toBeNull();
  });

  it('reads the mart for the caller’s company and filters by kind and axis', async () => {
    const results = {
      companyCode: jest.fn(() => Promise.resolve('OSD')),
      campaigns: jest.fn(() =>
        Promise.resolve([
          row(),
          row({ campaign_id: 'cmp-2', kind: 'campaign' }),
        ]),
      ),
      months: jest.fn(() => Promise.resolve([])),
      refreshedAt: jest.fn(() =>
        Promise.resolve(new Date('2026-10-06T07:00:00Z')),
      ),
    };
    const service = new CampaignResultsService(results as never);

    const view = await service.overview(actor, {
      kind: 'event',
      from: '2026-01',
    });

    expect(results.campaigns).toHaveBeenCalledWith('OSD');
    expect(results.months).toHaveBeenCalledWith('OSD', '2026-01', null);
    expect(view.campaigns.map((c) => c.campaign_id)).toEqual(['cmp-1']);
    expect(view.campaigns[0]).toMatchObject({
      start_date: '2026-10-01',
      conversion: 0.1,
    });
    expect(view.refreshed_at).toBe('2026-10-06T07:00:00.000Z');
  });

  it('a campaign of another company answers 404', async () => {
    const service = new CampaignResultsService({
      companyCode: jest.fn(() => Promise.resolve('OSD')),
      campaigns: jest.fn(() => Promise.resolve([row()])),
    } as never);
    await expect(service.campaign(actor, 'elsewhere')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('the mart credits the Lead’s campaign and leaves voided spend and cancelled orders out', () => {
    const sql = CAMPAIGN_MART_TABLES.flatMap((t) => t.sql).join('\n');
    expect(sql).toContain('l."campaignId" AS cid');
    expect(sql).toContain('"voidedAt" IS NULL');
    expect(sql).toContain("so.status::text <> 'cancelled'");
    expect(CAMPAIGN_MART_TABLES.map((t) => t.table)).toEqual([
      'fact_campaigns',
      'fact_campaign_monthly',
    ]);
  });
});
