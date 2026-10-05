import {
  budgetLaborMandays,
  compareBreakdown,
  plannedOnDay,
  solutionLaborByCode,
  stepsDue,
  varianceLabel,
} from './manday-rules';

describe('CD-233 manday rules', () => {
  it('รวม manday แรงงานจากบรรทัดงบ', () => {
    expect(
      budgetLaborMandays([
        { category: 'labor', quantity: 10, unit: 'man-day' },
        { category: 'material', quantity: 5 },
        { category: 'labor', quantity: 2.5 },
      ]),
    ).toBe(12.5);
    expect(budgetLaborMandays(null)).toBe(0);
  });

  it('แยกตามระดับ × ประเภทงาน และเทียบกับจริง', () => {
    const plan = solutionLaborByCode([
      { levelCode: 'SE-2', workTypeCode: 'INSTALL', mandays: 10 },
      { levelCode: 'SE-2', workTypeCode: 'INSTALL', mandays: 2 },
      { role: 'เก่า', mandays: 3 },
    ]);
    const rows = compareBreakdown(
      plan,
      new Map([
        ['SE-2|INSTALL', 15],
        ['PM|MANAGE', 4],
      ]),
    );
    expect(rows).toEqual([
      {
        levelCode: 'PM',
        workTypeCode: 'MANAGE',
        planned: 0,
        actual: 4,
        variance: 4,
        percent: null,
      },
      {
        levelCode: 'SE-2',
        workTypeCode: 'INSTALL',
        planned: 12,
        actual: 15,
        variance: 3,
        percent: 125,
      },
      {
        levelCode: null,
        workTypeCode: null,
        planned: 3,
        actual: 0,
        variance: -3,
        percent: 0,
      },
    ]);
  });

  it('ขั้นที่ถึงแล้วและยังไม่แจ้ง', () => {
    expect(stepsDue(104, [120, 100, 80], [80])).toEqual([100]);
    expect(stepsDue(null, [80], [])).toEqual([]);
    expect(varianceLabel(58, 50)).toBe('+16%');
    expect(varianceLabel(46, 50)).toBe('−8%');
    expect(varianceLabel(5, 0)).toBe('ไม่มีแผน');
  });

  it('แผนรายวันไม่เกินเวลาที่เหลือหลังลา', () => {
    const base = { working: true, capacity: 8, leaveHours: 0, bookedHours: 6 };
    expect(plannedOnDay(base)).toBe(6);
    expect(plannedOnDay({ ...base, leaveHours: 4 })).toBe(4);
    expect(plannedOnDay({ ...base, leaveHours: 8 })).toBe(0);
    expect(plannedOnDay({ ...base, working: false })).toBe(0);
  });
});
