import {
  jobMargin,
  labourLines,
  materialCost,
  materialLines,
  rebuildLines,
  timeTotals,
  type ChargeLine,
} from './time-material-rules';

const t = (over: Partial<Parameters<typeof timeTotals>[0][number]> = {}) => ({
  userId: 'u1',
  workTypeId: 'onsite',
  hours: 2,
  billable: true,
  approved: true,
  ...over,
});

const m = (
  over: Partial<Parameters<typeof materialLines>[0][number]> = {},
) => ({
  productCode: 'BRK-01',
  description: 'ขายึดกล้อง',
  quantity: 2,
  unit: 'ชิ้น',
  serialNo: null,
  billable: true,
  unitPrice: 450,
  unitCost: 300,
  ...over,
});

const names = (id: string) =>
  ({ onsite: 'ซ่อมหน้างาน', remote: 'ซัพพอร์ตทางไกล' })[id] ?? id;

describe('CD-243 time and materials rules', () => {
  it('counts hours by state — only approved and billable may be charged', () => {
    expect(
      timeTotals([
        t(),
        t({ hours: 1.5, approved: false }),
        t({ hours: 1, billable: false }),
      ]),
    ).toEqual({ approved: 3, pending: 1.5, billable: 2 });
  });

  it('makes one labour line per work type at its selling rate; a type with no rate is named', () => {
    const { lines, unrated } = labourLines(
      [
        t(),
        t({ userId: 'u2', hours: 1.5 }),
        t({ workTypeId: 'remote', hours: 1 }),
        t({ hours: 4, approved: false }),
      ],
      [{ workTypeId: 'onsite', hourlyRate: 800, productCode: 'SV-LAB' }],
      names,
    );
    expect(lines).toEqual([
      {
        productCode: 'SV-LAB',
        description: 'ค่าแรง ซ่อมหน้างาน',
        quantity: 3.5,
        unit: 'ชม.',
        unitPrice: 800,
        discountPct: 0,
        source: 'labour',
      },
    ]);
    expect(unrated).toEqual(['ซัพพอร์ตทางไกล']);
  });

  it('charges billable materials with a price; covered ones are not charged; unpriced are named', () => {
    const { lines, unpriced } = materialLines([
      m({ serialNo: 'SN1' }),
      m({ productCode: 'CAM-01', billable: false }),
      m({ productCode: 'CBL-01', unitPrice: null }),
    ]);
    expect(lines).toEqual([
      expect.objectContaining({
        productCode: 'BRK-01',
        description: 'ขายึดกล้อง · S/N SN1',
        quantity: 2,
        unitPrice: 450,
        source: 'material',
      }),
    ]);
    expect(unpriced).toEqual(['CBL-01']);
  });

  it('rebuilds a charge: typed lines stay, labour/material replaced, the estimate goes once there is actual', () => {
    const line = (source: ChargeLine['source'], description: string) =>
      ({
        productCode: null,
        description,
        quantity: 1,
        unit: null,
        unitPrice: 100,
        discountPct: 0,
        source,
      }) as ChargeLine;
    const existing = [
      line('estimate', 'ประมาณการ'),
      line('manual', 'ค่าเดินทาง'),
      line('labour', 'ค่าแรงเก่า'),
    ];
    expect(
      rebuildLines(existing, [line('labour', 'ค่าแรงใหม่')]).map(
        (row) => row.description,
      ),
    ).toEqual(['ค่าเดินทาง', 'ค่าแรงใหม่']);
    expect(rebuildLines(existing, []).map((row) => row.description)).toEqual([
      'ประมาณการ',
      'ค่าเดินทาง',
    ]);
  });

  it('costs materials and the margin', () => {
    expect(materialCost([m(), m({ unitCost: null })])).toEqual({
      cost: 600,
      unknownCost: 1,
    });
    expect(
      jobMargin({ revenue: 4000, labourCost: 1500, materialCost: 600 }),
    ).toEqual({ cost: 2100, profit: 1900, marginPct: 47.5 });
    expect(
      jobMargin({ revenue: 0, labourCost: 500, materialCost: 0 }).marginPct,
    ).toBeNull();
  });
});
