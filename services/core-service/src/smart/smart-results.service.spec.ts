import type { Principal } from '@request-management/share';
import { SmartResultsService, withRates } from './smart-results.service';

const actor = { userId: 'u-1', activeCompanyId: 'osd' } as unknown as Principal;

const row = (overrides: Record<string, unknown> = {}) => ({
  key: null,
  label: null,
  swept: 100,
  screened: 80,
  called: 40,
  reached: 20,
  refused: 5,
  interested: 8,
  handed_off: 6,
  deal: 4,
  won: 1,
  ...overrides,
});

function harness(code: string | null = 'OSD') {
  const results = {
    companyCode: jest.fn(() => Promise.resolve(code)),
    funnel: jest.fn((_c: string, _f: unknown, group: string | null) =>
      Promise.resolve(group ? [row({ key: group, label: group })] : [row()]),
    ),
    callMonths: jest.fn(() =>
      Promise.resolve([
        { month: '2026-10', calls: 50, reached: 25, refused: 5, interested: 8 },
      ]),
    ),
    refreshedAt: jest.fn(() =>
      Promise.resolve(new Date('2026-10-08T03:00:00Z')),
    ),
  };
  return { results, service: new SmartResultsService(results as never) };
}

describe('CD-295 AI SMART results', () => {
  it('rates follow the funnel: reached of called, refused of reached, won of deals', () => {
    expect(withRates(row())).toMatchObject({
      reach_rate: 0.5,
      refusal_rate: 0.25,
      interest_rate: 0.4,
      deal_rate: 0.04,
      win_rate: 0.25,
    });
    expect(withRates(row({ called: 0, reached: 0, deal: 0 }))).toMatchObject({
      reach_rate: null,
      refusal_rate: null,
      win_rate: null,
    });
  });

  it('one funnel plus the splits by source, axis, list and month, for the active company', async () => {
    const h = harness();
    const result = await h.service.overview(actor, {
      sales_axis: 'getter',
      from: '2026-09',
    });
    expect(h.results.companyCode).toHaveBeenCalledWith('osd');
    const filters = {
      sourceId: null,
      salesAxis: 'getter',
      callListId: null,
      from: '2026-09',
      to: null,
    };
    for (const group of [null, 'source', 'axis', 'list', 'month']) {
      expect(h.results.funnel).toHaveBeenCalledWith('OSD', filters, group);
    }
    expect(result.total.swept).toBe(100);
    expect(result.by_list[0]).toMatchObject({ key: 'list', reach_rate: 0.5 });
    expect(result.calls[0]).toMatchObject({
      reach_rate: 0.5,
      refusal_rate: 0.2,
    });
    expect(result.refreshed_at).toBe('2026-10-08T03:00:00.000Z');
  });

  it('nothing in the mart yet → zeros, not an error', async () => {
    const h = harness();
    h.results.funnel.mockResolvedValue([]);
    const result = await h.service.overview(actor, {});
    expect(result.total).toMatchObject({ swept: 0, reach_rate: null });
    expect(result.by_source).toEqual([]);
  });

  it('an unknown active company is refused', async () => {
    await expect(harness(null).service.overview(actor, {})).rejects.toThrow();
  });
});
