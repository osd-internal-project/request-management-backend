import type { Principal } from '@request-management/share';
import {
  PricingAnalyticsService,
  withRatios,
} from './pricing-analytics.service';

const sums = (net: number, cost: number, gross: number) => ({
  key: 'x',
  quotations: 1,
  gross,
  discount: gross - net,
  net,
  cost,
  margin: net - cost,
});

describe('CD-208 วิเคราะห์ราคาและกำไร', () => {
  it('margin % of net and discount % of gross, 2 places; none without revenue', () => {
    expect(withRatios(sums(3700, 2800, 4000))).toMatchObject({
      margin_pct: 24.32,
      discount_pct: 7.5,
    });
    expect(withRatios(sums(0, 10, 0))).toMatchObject({
      margin_pct: null,
      discount_pct: null,
    });
  });

  it('reads the active company with its filters; a bad month is refused', async () => {
    const repo = {
      companyCode: jest.fn(() => Promise.resolve('OSD')),
      totals: jest.fn(() => Promise.resolve(sums(1, 0, 1))),
      monthly: jest.fn(() => Promise.resolve([])),
      exceptionsMonthly: jest.fn(() => Promise.resolve([])),
      refreshedAt: jest.fn(() => Promise.resolve(null)),
      by: jest.fn(() => Promise.resolve([])),
    };
    const service = new PricingAnalyticsService(repo as never);
    const actor = { activeCompanyId: 'osd' } as unknown as Principal;

    const out = await service.overview(actor, {
      from: '2026-01',
      to: '2026-06',
      accepted_only: 'true',
    });
    expect(repo.totals).toHaveBeenCalledWith({
      companyCode: 'OSD',
      from: '2026-01',
      to: '2026-06',
      acceptedOnly: true,
    });
    expect(Object.keys(out.by)).toEqual([
      'customer',
      'work_type',
      'salesperson',
      'vendor',
      'product_group',
    ]);
    await expect(
      service.overview(actor, { from: '2026-13' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
