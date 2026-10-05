import { costTotals, groupCosts, priceLine, type Rate } from './labor-cost';

const rates: Rate[] = [
  {
    levelId: 'SE',
    workTypeId: 'INSTALL',
    validFrom: '2026-01-01',
    validTo: '2026-09-30',
    costPerManday: 4000,
  },
  {
    levelId: 'SE',
    workTypeId: 'INSTALL',
    validFrom: '2026-10-01',
    validTo: null,
    costPerManday: 4800,
  },
];

describe('CD-234 labour cost', () => {
  it('ใช้อัตราที่มีผลในวันที่ทำงาน', () => {
    const line = { levelId: 'SE', workTypeId: 'INSTALL', hours: 4 };
    expect(priceLine({ ...line, date: '2026-09-30' }, rates)).toMatchObject({
      costPerManday: 4000,
      cost: 2000,
    });
    expect(priceLine({ ...line, date: '2026-10-01' }, rates)).toMatchObject({
      costPerManday: 4800,
      cost: 2400,
    });
  });

  it('ไม่มีระดับหรือไม่มีอัตรา = ชั่วโมงที่คิดราคาไม่ได้ ไม่เดา', () => {
    const lines = [
      priceLine(
        { levelId: 'SE', workTypeId: 'INSTALL', date: '2026-10-02', hours: 8 },
        rates,
      ),
      priceLine(
        { levelId: null, workTypeId: 'INSTALL', date: '2026-10-02', hours: 2 },
        rates,
      ),
      priceLine(
        { levelId: 'SE', workTypeId: 'INSTALL', date: '2025-12-31', hours: 3 },
        rates,
      ),
    ];
    expect(lines.map((l) => l.cost)).toEqual([4800, null, null]);
    expect(costTotals(lines)).toEqual({
      hours: 13,
      mandays: 1.63,
      cost: 4800,
      unpricedHours: 5,
    });
  });

  it('รวมเป็นกลุ่ม', () => {
    const rows = groupCosts(
      [
        { r: 'A', hours: 8, cost: 4000 },
        { r: 'B', hours: 4, cost: null },
        { r: 'A', hours: 4, cost: 2000 },
      ],
      (line) => line.r,
    );
    expect(rows).toEqual([
      { key: 'A', hours: 12, mandays: 1.5, cost: 6000, unpricedHours: 0 },
      { key: 'B', hours: 4, mandays: 0.5, cost: 0, unpricedHours: 4 },
    ]);
  });
});
