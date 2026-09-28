import {
  applyComputedFields,
  computedFieldProblems,
  marginPct,
} from './computed-fields';
import { assertUsableFormSchema } from './submit-rules';

const DSC = {
  type: 'object',
  properties: {
    deal_value: { type: 'number' },
    discount_pct: { type: 'number' },
    cost: { type: 'number' },
    est_margin_pct: {
      type: 'number',
      'x-computed': {
        kind: 'margin_pct',
        value: 'deal_value',
        discount_pct: 'discount_pct',
        cost: 'cost',
      },
    },
    reason: { type: 'string' },
  },
};

describe('CD-80 computed margin', () => {
  it('margin left after the discount, on the discounted value', () => {
    // 100,000 less 10% = 90,000; cost 72,000 → 18,000 / 90,000 = 20%
    expect(marginPct(100_000, 10, 72_000)).toBe(20);
    // the quotation fixture: 25,000 less 8% = 23,000; cost 15,000 → 34.78%
    expect(marginPct(25_000, 8, 15_000)).toBe(34.78);
    // a loss is a negative margin, shown as such
    expect(marginPct(10_000, 0, 12_000)).toBe(-20);
  });

  it('unknown when an input is missing or nothing is left to sell', () => {
    expect(marginPct(null, 10, 1)).toBeNull();
    expect(marginPct(100, 10, null)).toBeNull();
    expect(marginPct(100, 100, 50)).toBeNull();
  });

  it('CD-80: a margin typed into the request body is replaced by the computed one', () => {
    const data = applyComputedFields(DSC, {
      deal_value: 100_000,
      discount_pct: '10',
      cost: 72_000,
      est_margin_pct: 45, // made up
      reason: 'ลูกค้ารายใหญ่',
    });
    expect(data.est_margin_pct).toBe(20);
    expect(data.reason).toBe('ลูกค้ารายใหญ่');
  });

  it('clearing an input removes the stale margin instead of keeping it', () => {
    const data = applyComputedFields(DSC, {
      deal_value: 100_000,
      discount_pct: 10,
      est_margin_pct: 20,
    });
    expect(data).not.toHaveProperty('est_margin_pct');
  });

  it('a type without a formula is left exactly as sent', () => {
    const schema = { properties: { est_margin_pct: { type: 'number' } } };
    expect(applyComputedFields(schema, { est_margin_pct: 12 })).toEqual({
      est_margin_pct: 12,
    });
  });

  it('A2 refuses a formula that names a missing or non-number field', () => {
    expect(computedFieldProblems(DSC)).toEqual([]);
    const broken = {
      properties: {
        ...DSC.properties,
        est_margin_pct: {
          type: 'number',
          'x-computed': { kind: 'margin_pct', value: 'reason', cost: 'nope' },
        },
      },
    };
    expect(computedFieldProblems(broken).map((d) => d.reason)).toEqual([
      'สูตรอ้างฟิลด์ "reason" ที่ไม่มีหรือไม่ใช่ตัวเลข',
      'สูตรอ้างฟิลด์ "nope" ที่ไม่มีหรือไม่ใช่ตัวเลข',
    ]);
    expect(() => assertUsableFormSchema(broken)).toThrow(
      'โครงสร้างฟอร์มไม่ถูกต้อง',
    );
  });
});
