import {
  billingReference,
  confirmBlocker,
  estimateLine,
  lineProblems,
  lineTotal,
  netTotal,
  prepareBlocker,
} from './billing-rules';

const line = (over: Partial<Parameters<typeof lineTotal>[0]> = {}) => ({
  productCode: null,
  description: 'ค่าบริการ',
  quantity: 1,
  unit: null,
  unitPrice: 1000,
  discountPct: 0,
  ...over,
});

describe('CD-242 service billing rules', () => {
  it('adds a line up to the satang, less its discount', () => {
    expect(lineTotal({ quantity: 3, unitPrice: 333.33, discountPct: 10 })).toBe(
      899.99,
    );
    expect(netTotal([line(), line({ quantity: 2, unitPrice: 250 })])).toBe(
      1500,
    );
  });

  it('bills only a confirmed billed job, and only once it is done', () => {
    expect(prepareBlocker({ billing: 'in_contract' }, 'completed')).toContain(
      'เก็บเงินเพิ่ม',
    );
    expect(prepareBlocker({ billing: null }, 'completed')).toContain(
      'เก็บเงินเพิ่ม',
    );
    expect(prepareBlocker({ billing: 'billable' }, 'in_progress')).toContain(
      'งานเสร็จ',
    );
    for (const status of ['completed', 'approved', 'closed']) {
      expect(prepareBlocker({ billing: 'billable' }, status)).toBeNull();
    }
  });

  it('checks the lines and what may be sent', () => {
    expect(lineProblems([line()])).toEqual([]);
    expect(
      lineProblems([
        line({ description: ' ' } as never),
        line({ quantity: 0 }),
        line({ unitPrice: -1 }),
        line({ discountPct: 101 }),
      ]),
    ).toEqual([
      'บรรทัด 1: ต้องมีรายละเอียด',
      'บรรทัด 2: จำนวนต้องมากกว่า 0',
      'บรรทัด 3: ราคาต้องไม่ติดลบ',
      'บรรทัด 4: ส่วนลดต้องอยู่ระหว่าง 0–100%',
    ]);
    expect(confirmBlocker([])).toBe('ยังไม่มีรายการเรียกเก็บ');
    expect(confirmBlocker([line({ unitPrice: 0 })])).toBe(
      'ยอดเรียกเก็บต้องมากกว่า 0',
    );
    expect(confirmBlocker([line()])).toBeNull();
  });

  it('starts from the estimate the customer agreed to', () => {
    expect(estimateLine('กล้องภาพไม่ขึ้น', 3500)).toMatchObject({
      description: 'ค่าบริการ กล้องภาพไม่ขึ้น',
      quantity: 1,
      unitPrice: 3500,
    });
    expect(estimateLine('x', null)).toBeNull();
    expect(estimateLine('x', 0)).toBeNull();
  });

  it('references the job by its request number', () => {
    expect(billingReference('REQ-OSD-2610-0001', 'abc')).toBe(
      'SVB-REQ-OSD-2610-0001',
    );
    expect(billingReference(null, 'abcdef12-3456')).toBe('SVB-ABCDEF12');
  });
});
