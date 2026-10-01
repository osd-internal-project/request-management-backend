import { markupPrice } from '../crm/quotation-math';
import { cleanMarkup, pickMarkup } from './markup-rules';

const rule = (over: Record<string, unknown>) => ({
  id: 'r',
  priority: 100,
  workType: null,
  productGroupCode: null,
  segmentValueId: null,
  markupPct: 20,
  active: true,
  ...over,
});

describe('markup rules (CD-200)', () => {
  it('empty conditions match all; lowest priority wins, then most specific', () => {
    const rules = [
      rule({ id: 'all', priority: 100, markupPct: 20 }),
      rule({
        id: 'equip',
        priority: 100,
        workType: 'equipment',
        markupPct: 15,
      }),
      rule({
        id: 'equip-voice',
        priority: 100,
        workType: 'equipment',
        productGroupCode: '101',
        markupPct: 12,
      }),
      rule({
        id: 'vip',
        priority: 10,
        segmentValueId: 'seg-vip',
        markupPct: 8,
      }),
      rule({ id: 'off', priority: 1, markupPct: 1, active: false }),
    ];
    const ctx = {
      workType: 'equipment',
      groupCode: '101',
      segmentValueIds: [],
    };
    expect(pickMarkup(rules, ctx)?.id).toBe('equip-voice');
    expect(
      pickMarkup(rules, { ...ctx, segmentValueIds: ['seg-vip'] })?.id,
    ).toBe('vip');
    expect(
      pickMarkup(rules, { workType: 'service', segmentValueIds: [] })?.id,
    ).toBe('all');
    expect(pickMarkup([], { segmentValueIds: [] })).toBeNull();
  });

  it('markupPrice = cost × (1 + pct), rounded to 2 places', () => {
    expect(markupPrice(1000, 20)).toBe(1200);
    expect(markupPrice(333.33, 15)).toBe(383.33);
    expect(markupPrice(1000, 0)).toBe(1000);
  });

  it('cleanMarkup validates and defaults', () => {
    expect(cleanMarkup({ markupPct: 12.345, workType: ' ' })).toEqual({
      ok: true,
      value: {
        priority: 100,
        workType: null,
        productGroupCode: null,
        segmentValueId: null,
        markupPct: 12.35,
        note: '',
        active: true,
      },
    });
    expect(
      cleanMarkup({ markupPct: -1, workType: 'food', priority: 1.5 }),
    ).toEqual({
      ok: false,
      problems: [
        { field: 'priority', reason: 'invalid' },
        { field: 'work_type', reason: 'invalid' },
        { field: 'markup_pct', reason: 'invalid' },
      ],
    });
  });
});
