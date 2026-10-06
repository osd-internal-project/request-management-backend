import {
  lineProblems,
  overBudget,
  plannedTotal,
  progress,
  spendProblems,
  spentByLine,
  spentTotal,
} from './campaign-plan-rules';

describe('CD-268 campaign plan rules', () => {
  const spends = [
    { budgetLineId: 'fb', amount: 30_000.5, voided: false },
    { budgetLineId: 'fb', amount: 10_000, voided: true },
    { budgetLineId: 'expo', amount: 50_000, voided: false },
    { budgetLineId: null, amount: 1_200, voided: false },
  ];

  it('budget is the sum of the lines; voided spend never counts', () => {
    expect(
      plannedTotal([
        { id: 'fb', planned: 80_000 },
        { id: 'expo', planned: 40_000.25 },
      ]),
    ).toBe(120_000.25);
    expect(spentTotal(spends)).toBe(81_200.5);
    expect(spentByLine(spends)).toEqual(
      new Map([
        ['fb', 30_000.5],
        ['expo', 50_000],
        ['', 1_200],
      ]),
    );
  });

  it('over budget only when there is a plan and spend passes it', () => {
    expect(overBudget(40_000, 50_000)).toBe(true);
    expect(overBudget(40_000, 40_000)).toBe(false);
    expect(overBudget(null, 50_000)).toBe(false);
  });

  it('progress is actual over target, none without a target', () => {
    expect(progress(40, 10)).toBe(0.25);
    expect(progress(2, 3)).toBe(1.5);
    expect(progress(null, 3)).toBeNull();
    expect(progress(0, 3)).toBeNull();
  });

  it('lines need a channel, once each, and no negative budget', () => {
    expect(lineProblems([{ channel: 'Facebook', planned: 1 }])).toEqual([]);
    expect(
      lineProblems([
        { channel: 'Facebook', planned: 1 },
        { channel: 'facebook ', planned: 2 },
        { channel: ' ', planned: -1 },
      ]),
    ).toHaveLength(3);
  });

  it('spend is positive and not in the future', () => {
    expect(
      spendProblems({ amount: 10, spentOn: '2026-10-06', today: '2026-10-06' }),
    ).toEqual([]);
    expect(
      spendProblems({ amount: 0, spentOn: '2026-10-07', today: '2026-10-06' }),
    ).toHaveLength(2);
  });
});
