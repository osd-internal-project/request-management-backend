import {
  compareCosts,
  costEntryProblems,
  laborCost,
  newCrossings,
} from './cost-rules';

describe('CD-190 project cost rules', () => {
  const rates = [
    {
      levelId: 'L2',
      workTypeId: 'W1',
      validFrom: '2026-01-01',
      validTo: '2026-09-30',
      costPerManday: 4000,
    },
    {
      levelId: 'L2',
      workTypeId: 'W1',
      validFrom: '2026-10-01',
      validTo: null,
      costPerManday: 4800,
    },
  ];

  it('hours cost the rate of their own day; unpriced hours are counted apart', () => {
    expect(
      laborCost(
        [
          { levelId: 'L2', workTypeId: 'W1', date: '2026-09-30', hours: 8 },
          { levelId: 'L2', workTypeId: 'W1', date: '2026-10-01', hours: 4 },
          { levelId: null, workTypeId: 'W1', date: '2026-10-01', hours: 3 },
          { levelId: 'L2', workTypeId: 'W9', date: '2026-10-01', hours: 1 },
        ],
        rates,
      ),
    ).toEqual({ amount: 6400, hours: 16, mandays: 2, unpricedHours: 4 });
  });

  it('actual against budget per category and in total', () => {
    const rows = compareCosts({
      budget: { material: 100000, labor: 50000, other: 0 },
      actual: { material: 95000, labor: 60000, other: 1000 },
      warnPct: 90,
      alertPct: 100,
    });
    expect(rows.map((row) => [row.category, row.pct, row.level])).toEqual([
      ['material', 95, 'warn'],
      ['labor', 120, 'over'],
      // spent with nothing budgeted
      ['other', null, 'over'],
      ['total', 104, 'over'],
    ]);
  });

  it('each level is told once per budget version', () => {
    const rows = compareCosts({
      budget: { material: 100, labor: 100, other: 100 },
      actual: { material: 95, labor: 101, other: 0 },
      warnPct: 90,
      alertPct: 100,
    });
    expect(
      newCrossings(rows, [{ category: 'material', level: 'warn' }]).map(
        (item) => `${item.category}:${item.level}`,
      ),
    ).toEqual(['labor:over']);
  });

  it('a manual entry needs its category, amount, date and evidence', () => {
    const ok = {
      category: 'material',
      description: 'ค่าเช่ารถกระเช้า',
      amount: 12000,
      incurredOn: '2026-10-04',
      today: '2026-10-05',
      hasEvidence: true,
    };
    expect(costEntryProblems(ok)).toEqual([]);
    expect(
      costEntryProblems({
        ...ok,
        category: 'labor',
        amount: 0,
        incurredOn: '2026-10-06',
        hasEvidence: false,
      }),
    ).toHaveLength(4);
  });
});
