import {
  capDiscounts,
  cleanMinMargins,
  computeQuotationTotals,
  dealMargin,
  defaultValidUntil,
  marginByWorkType,
  marginNeedsApproval,
  maxDiscountWithin,
  monthlyRecurring,
  priceModelProblems,
  overallDiscountPct,
  quotationExpired,
} from './quotation-math';

describe('CD-76 ใบเสนอราคา — วันหมดอายุตามเวลาไทย', () => {
  const validUntil = new Date('2026-09-30T00:00:00.000Z');

  it('ยังใช้ได้ตลอดวันที่ระบุ จนถึง 23:59 น. เวลาไทย', () => {
    // 2026-09-30 23:59 +07:00 = 16:59Z
    expect(quotationExpired(validUntil, new Date('2026-09-30T16:59:00Z'))).toBe(
      false,
    );
  });

  it('หมดอายุตั้งแต่เที่ยงคืนของวันถัดไปเวลาไทย', () => {
    // 2026-10-01 00:00 +07:00 = 2026-09-30 17:00Z
    expect(quotationExpired(validUntil, new Date('2026-09-30T17:00:00Z'))).toBe(
      true,
    );
  });

  it('ไม่มีวันหมดอายุ = ไม่หมดอายุ', () => {
    expect(quotationExpired(null, new Date())).toBe(false);
  });

  it('ค่าตั้งต้นนับจาก "วันนี้" ของไทย ไม่ใช่ของ UTC', () => {
    // 2026-09-15 23:30 +07:00 เป็นวันที่ 15 ในไทย แต่ UTC ยังเป็น 15 เช่นกัน;
    // 2026-09-16 01:00 +07:00 = 2026-09-15 18:00Z — ไทยเป็นวันที่ 16 แล้ว
    expect(
      defaultValidUntil(30, new Date('2026-09-15T18:00:00Z')).toISOString(),
    ).toBe('2026-10-16T00:00:00.000Z');
  });
});

/** CD-76 — totals and the margin check, which decide whether a quotation needs approval. */
describe('CD-76 ใบเสนอราคา — ยอดรวมและ margin', () => {
  it('คำนวณยอดต่อบรรทัด ส่วนลด VAT ต้นทุน และ margin', () => {
    const totals = computeQuotationTotals(
      [
        { quantity: 2, unit_price: 10000, unit_cost: 7000, discount_pct: 10 },
        { quantity: 1, unit_price: 5000, unit_cost: 1000 },
      ],
      7,
    );

    expect(totals.lines[0].lineTotal.toFixed(2)).toBe('18000.00');
    expect(totals.lines[0].lineCost.toFixed(2)).toBe('14000.00');
    expect(totals.subtotal.toFixed(2)).toBe('25000.00');
    expect(totals.discountTotal.toFixed(2)).toBe('2000.00');
    expect(totals.netTotal.toFixed(2)).toBe('23000.00');
    expect(totals.vatAmount.toFixed(2)).toBe('1610.00');
    expect(totals.grandTotal.toFixed(2)).toBe('24610.00');
    expect(totals.costTotal.toFixed(2)).toBe('15000.00');
    expect(totals.marginAmount.toFixed(2)).toBe('8000.00');
    // 8000 / 23000 = 34.7826…%
    expect(totals.marginPct?.toFixed(2)).toBe('34.78');
    expect(overallDiscountPct(totals).toFixed(2)).toBe('8.00');
  });

  it('ไม่หลุดทศนิยมแบบ number — 0.1 + 0.2 ต้องเป็น 0.30 พอดี', () => {
    const totals = computeQuotationTotals(
      [
        { quantity: 1, unit_price: '0.1' },
        { quantity: 1, unit_price: '0.2' },
      ],
      0,
    );

    expect(totals.netTotal.toFixed(2)).toBe('0.30');
  });

  it('margin เท่ากับเกณฑ์พอดีไม่ต้องขออนุมัติ ต่ำกว่าเกณฑ์ต้องขอ', () => {
    const exactly15 = computeQuotationTotals(
      [{ quantity: 1, unit_price: 100, unit_cost: 85 }],
      7,
    );
    const below = computeQuotationTotals(
      [{ quantity: 1, unit_price: 100, unit_cost: 85.01 }],
      7,
    );

    expect(marginNeedsApproval(exactly15.marginPct, 15)).toBe(false);
    expect(marginNeedsApproval(below.marginPct, 15)).toBe(true);
  });

  it('ไม่มีรายได้ (ยอดสุทธิ 0) หาร margin ไม่ได้ = ต้องขออนุมัติ', () => {
    const free = computeQuotationTotals(
      [{ quantity: 1, unit_price: 100, unit_cost: 50, discount_pct: 100 }],
      7,
    );

    expect(free.marginPct).toBeNull();
    expect(marginNeedsApproval(free.marginPct, 0)).toBe(true);
  });
});

describe('CD-196 รูปแบบราคา', () => {
  it('เหมา = จำนวน 1 เสมอ, รายเดือน = จำนวน × เดือน, ต่อหน่วยเหมือนเดิม', () => {
    const totals = computeQuotationTotals(
      [
        { quantity: 3, unit_price: 1000, unit_cost: 600 },
        {
          quantity: 5,
          unit_price: 20000,
          unit_cost: 12000,
          price_model: 'lump_sum',
        },
        {
          quantity: 2,
          unit_price: 500,
          unit_cost: 300,
          discount_pct: 10,
          price_model: 'monthly',
          term_months: 12,
        },
      ],
      7,
    );
    expect(totals.lines.map((line) => line.lineTotal.toFixed(2))).toEqual([
      '3000.00',
      '20000.00',
      '10800.00',
    ]);
    expect(totals.lines.map((line) => line.lineCost.toFixed(2))).toEqual([
      '1800.00',
      '12000.00',
      '7200.00',
    ]);
    expect(totals.netTotal.toFixed(2)).toBe('33800.00');
  });

  it('รายเดือนต้องมีจำนวนเดือน 1–120', () => {
    expect(
      priceModelProblems([
        { quantity: 1, unit_price: 1, price_model: 'monthly' },
        {
          quantity: 1,
          unit_price: 1,
          price_model: 'monthly',
          term_months: 121,
        },
        { quantity: 1, unit_price: 1, price_model: 'monthly', term_months: 12 },
        { quantity: 1, unit_price: 1 },
      ]),
    ).toEqual([
      { field: 'lines[0].term_months', reason: 'required_1_120' },
      { field: 'lines[1].term_months', reason: 'required_1_120' },
    ]);
  });

  it('ค่าบริการรายเดือน = ยอดหลังส่วนลดของบรรทัดรายเดือน ÷ จำนวนเดือน', () => {
    expect(
      monthlyRecurring([
        { priceModel: 'monthly', termMonths: 12, lineTotal: '10800.00' },
        { priceModel: 'unit', termMonths: null, lineTotal: '3000.00' },
      ]).toFixed(2),
    ).toBe('900.00');
  });
});

describe('CD-199 margin ของดีล', () => {
  const now = new Date('2026-10-01T05:00:00Z');
  const future = new Date('2026-12-31T00:00:00Z');
  const past = new Date('2026-09-01T00:00:00Z');
  const row = (over: Record<string, unknown>) => ({
    id: 'q',
    quotationNo: 'QT-1',
    version: 1,
    status: 'draft',
    validUntil: future,
    netTotal: 0,
    costTotal: 0,
    ...over,
  });

  it('นับเวอร์ชันล่าสุดของแต่ละเลขที่ยังมีผล — ไม่นับที่ยกเลิก/ปฏิเสธ/หมดอายุ', () => {
    const result = dealMargin(
      [
        row({
          id: 'a1',
          version: 1,
          status: 'superseded',
          netTotal: 999,
          costTotal: 1,
        }),
        row({
          id: 'a2',
          version: 2,
          status: 'sent',
          netTotal: 10000,
          costTotal: 7000,
        }),
        row({
          id: 'b1',
          quotationNo: 'QT-2',
          status: 'accepted',
          validUntil: past,
          netTotal: 5000,
          costTotal: 4000,
        }),
        row({
          id: 'c1',
          quotationNo: 'QT-3',
          status: 'cancelled',
          netTotal: 8000,
          costTotal: 1,
        }),
        row({
          id: 'd1',
          quotationNo: 'QT-4',
          status: 'sent',
          validUntil: past,
          netTotal: 3000,
          costTotal: 1,
        }),
      ],
      now,
    );
    expect(result.quotations.map((q) => q.id)).toEqual(['a2', 'b1']);
    expect(result.netTotal.toFixed(2)).toBe('15000.00');
    expect(result.costTotal.toFixed(2)).toBe('11000.00');
    expect(result.marginAmount.toFixed(2)).toBe('4000.00');
    expect(result.marginPct?.toFixed(2)).toBe('26.67');
  });

  it('ไม่มีรายได้ = margin % ว่าง', () => {
    expect(dealMargin([], now).marginPct).toBeNull();
  });
});

describe('CD-202 margin ตามประเภทงาน', () => {
  const lines = [
    { workType: 'service', lineTotal: 1000, lineCost: 700 },
    { workType: 'service', lineTotal: 1000, lineCost: 900 },
    { workType: 'equipment', lineTotal: 5000, lineCost: 4500 },
    { workType: null, lineTotal: 100, lineCost: 50 },
  ];

  it('รวมบรรทัดต่อประเภท แล้วเทียบเกณฑ์ของประเภทนั้น', () => {
    const groups = marginByWorkType(lines, { service: 25, equipment: 8 }, 15);
    expect(
      groups.map((g) => [
        g.workType,
        g.marginPct?.toNumber(),
        g.minMarginPct,
        g.below,
      ]),
    ).toEqual([
      ['equipment', 10, 8, false],
      ['service', 20, 25, true],
      [null, 50, 15, false],
    ]);
  });

  it('ประเภทที่ไม่ได้ตั้งเกณฑ์ใช้เกณฑ์ของบริษัท', () => {
    const groups = marginByWorkType(lines, {}, 15);
    expect(groups.find((g) => g.workType === 'equipment')?.below).toBe(true);
    expect(groups.find((g) => g.workType === 'service')?.below).toBe(false);
  });

  it('ไม่มีรายได้ = ต้องขออนุมัติ เหมือนทั้งใบ', () => {
    const [group] = marginByWorkType(
      [{ workType: 'software', lineTotal: 0, lineCost: 10 }],
      {},
      15,
    );
    expect(group.marginPct).toBeNull();
    expect(group.below).toBe(true);
  });

  it('ค่าตั้งค่า: ตัดประเภทที่ไม่รู้จักและตัวเลขนอก 0–100 ทิ้ง', () => {
    expect(
      cleanMinMargins({ service: '20', equipment: 150, foo: 5, software: '' }),
    ).toEqual({ service: 20 });
    expect(cleanMinMargins(null)).toEqual({});
  });
});

describe('CD-203 ทางเลือกส่วนลด', () => {
  it('ส่วนลดสูงสุดที่ยังได้ margin ถึงเกณฑ์พอดี', () => {
    // gross 10,000 cost 7,000 min 20% → net ≥ 8,750 → discount ≤ 12.5%
    expect(maxDiscountWithin(10000, 7000, 20)).toBe(12.5);
    // floored, never rounded up past the minimum
    expect(maxDiscountWithin(3000, 2000, 15)).toBe(21.56);
  });

  it('ราคาเต็มก็ยังต่ำกว่าเกณฑ์ หรือไม่มีรายได้ = ลดไม่ได้เลย', () => {
    expect(maxDiscountWithin(10000, 9500, 20)).toBe(0);
    expect(maxDiscountWithin(0, 100, 20)).toBe(0);
  });

  it('ตัดส่วนลดตามเพดานของประเภทงาน ไม่เพิ่มส่วนลดที่ต่ำกว่าเพดาน', () => {
    expect(
      capDiscounts(
        [
          { workType: 'service', discountPct: 20 },
          { workType: 'service', discountPct: 5 },
          { workType: 'equipment', discountPct: 30 },
          { workType: null, discountPct: 10 },
        ],
        { service: 12.5, none: 0 },
      ),
    ).toEqual([12.5, 5, 30, 0]);
  });
});
