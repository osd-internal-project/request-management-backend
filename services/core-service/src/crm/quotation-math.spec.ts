import {
  computeQuotationTotals,
  defaultValidUntil,
  marginNeedsApproval,
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
