import {
  budgetTotals,
  cleanLines,
  draftFromBaseline,
  lockProblems,
} from './budget-rules';

const baseline = {
  boq: [
    {
      kind: 'equipment',
      productCode: 'CAM-01',
      name: 'กล้อง',
      quantity: 20,
      unit: 'ตัว',
      refUnitCost: 3000,
    },
    {
      kind: 'material',
      productCode: 'CBL-01',
      name: 'สาย',
      quantity: 10,
      unit: 'ม้วน',
      refUnitCost: null,
    },
    {
      kind: 'service',
      productCode: 'SV-01',
      name: 'ขนส่ง',
      quantity: 1,
      unit: 'งาน',
      refUnitCost: null,
    },
  ],
  labor: [{ role: 'ช่าง', mandays: 10, rate: 2000 }],
  cost: { lines: [{ index: 1, unitCost: 500 }] },
};

describe('CD-179 the first draft', () => {
  it('takes the BOQ at the estimated cost, and labour as man-days at its rate', () => {
    const lines = draftFromBaseline(baseline);
    expect(
      lines.map((line) => [
        line.category,
        line.code,
        line.unitCost,
        line.amount,
      ]),
    ).toEqual([
      ['material', 'CAM-01', 3000, 60000],
      // the partner quote's price, not the reference
      ['material', 'CBL-01', 500, 5000],
      // a service line with no cost yet
      ['other', 'SV-01', null, 0],
      ['labor', null, 2000, 20000],
    ]);
    expect(lockProblems(lines)).toEqual(['ยังมี 1 รายการที่ไม่มีต้นทุน']);
  });

  it('is empty without a baseline to draw from', () => {
    expect(draftFromBaseline(null)).toEqual([]);
    expect(lockProblems([])).toEqual(['งบยังไม่มีรายการ']);
  });
});

describe('CD-179 lines and totals', () => {
  it('works out amounts and flags what is wrong', () => {
    const { lines, problems } = cleanLines([
      {
        category: 'other',
        description: ' ค่าเดินทาง ',
        quantity: 3,
        unit_cost: 1500.5,
      },
      { category: 'material', description: '', quantity: 0, unit_cost: -1 },
    ]);
    expect(lines[0]).toMatchObject({
      description: 'ค่าเดินทาง',
      amount: 4501.5,
    });
    expect(problems).toHaveLength(3);
  });

  it('totals by category and the margin against the contract value', () => {
    const lines = draftFromBaseline(baseline);
    expect(budgetTotals(lines, 150000)).toEqual({
      byCategory: { material: 65000, labor: 20000, other: 0 },
      total: 85000,
      margin: 65000,
      marginPct: 43.3,
      missingCost: 1,
    });
  });
});
