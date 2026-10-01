import {
  budgetAfter,
  changeImpact,
  cleanChangeLines,
  costChangeOf,
  submitProblems,
} from './change-rules';

describe('CD-185 the cost of a change', () => {
  it('takes lines that add and lines that take away, each with its cost', () => {
    const { lines, problems } = cleanChangeLines([
      {
        category: 'material',
        description: 'กล้องเพิ่ม',
        quantity: 5,
        unit_cost: 3000,
      },
      {
        category: 'labor',
        description: 'ตัดงานอบรม',
        quantity: -2,
        unit_cost: 2000,
      },
    ]);
    expect(problems).toEqual([]);
    expect(costChangeOf(lines)).toBe(11000);
  });

  it('refuses a line with no cost or a zero quantity', () => {
    expect(
      cleanChangeLines([
        { category: 'other', description: 'x', quantity: 0, unit_cost: 1 },
        { category: 'other', description: 'y', quantity: 1, unit_cost: null },
      ]).problems,
    ).toHaveLength(2);
  });
});

describe('CD-185 the new margin', () => {
  it('works out cost, value and margin before and after', () => {
    expect(
      changeImpact({ total: 80000, contractValue: 150000 }, 11000, 20000),
    ).toEqual({
      cost: { from: 80000, to: 91000, change: 11000 },
      value: { from: 150000, to: 170000, change: 20000 },
      margin: { from: 70000, to: 79000, fromPct: 46.7, toPct: 46.5 },
    });
  });

  it('cannot say without a budget', () => {
    expect(
      changeImpact({ total: null, contractValue: 150000 }, 0, 0).margin,
    ).toEqual({ from: null, to: null, fromPct: null, toPct: null });
  });
});

describe('CD-185 before it goes to the board', () => {
  const ok = {
    title: 'เพิ่มกล้องชั้น 2',
    reason: 'ลูกค้าขอเพิ่ม',
    scopeAdded: 'กล้อง 5 ตัว',
    scopeRemoved: null,
    scheduleDays: 3,
    lines: 1,
    priceChange: 20000,
    budgetLocked: true,
  };

  it('needs a subject, a reason and some effect', () => {
    expect(submitProblems(ok)).toEqual([]);
    expect(
      submitProblems({
        ...ok,
        scopeAdded: null,
        scheduleDays: 0,
        lines: 0,
        priceChange: 0,
      }),
    ).toHaveLength(1);
    expect(submitProblems({ ...ok, reason: ' ' })).toHaveLength(1);
  });

  it('a cost change needs a confirmed budget to change', () => {
    expect(submitProblems({ ...ok, budgetLocked: false })).toHaveLength(1);
    expect(submitProblems({ ...ok, lines: 0, budgetLocked: false })).toEqual(
      [],
    );
  });
});

describe('CD-185 the budget it leaves', () => {
  it('adds its lines, marked with the change', () => {
    const current = [
      {
        category: 'material' as const,
        code: 'A',
        description: 'กล้อง',
        quantity: 20,
        unit: null,
        unitCost: 3000,
        amount: 60000,
      },
    ];
    const change = cleanChangeLines([
      {
        category: 'material',
        description: 'กล้องเพิ่ม',
        quantity: 5,
        unit_cost: 3000,
      },
    ]).lines;
    expect(
      budgetAfter(current, change, 'CR-1').map((line) => line.description),
    ).toEqual(['กล้อง', 'CR-1: กล้องเพิ่ม']);
  });
});
