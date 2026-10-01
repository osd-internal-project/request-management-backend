import {
  cleanPrice,
  cleanTarget,
  pickApplicable,
  dayBefore,
  hasStarted,
  revisionProblems,
  startedEditProblems,
  isIsoDate,
  overlaps,
  priceOn,
  priceStatus,
} from './price-rules';

describe('price rules (CD-194)', () => {
  it('overlaps: shared days count, an open end runs forever', () => {
    const jan = { validFrom: '2026-01-01', validTo: '2026-01-31' };
    expect(overlaps(jan, { validFrom: '2026-01-31', validTo: null })).toBe(
      true,
    );
    expect(overlaps(jan, { validFrom: '2026-02-01', validTo: null })).toBe(
      false,
    );
    expect(overlaps({ validFrom: '2026-03-01', validTo: null }, jan)).toBe(
      false,
    );
    expect(
      overlaps(
        { validFrom: '2025-01-01', validTo: null },
        { validFrom: '2030-01-01', validTo: '2030-12-31' },
      ),
    ).toBe(true);
  });

  it('priceStatus: validTo is the last valid day', () => {
    const range = { validFrom: '2026-10-01', validTo: '2026-10-31' };
    expect(priceStatus(range, '2026-09-30')).toBe('future');
    expect(priceStatus(range, '2026-10-01')).toBe('current');
    expect(priceStatus(range, '2026-10-31')).toBe('current');
    expect(priceStatus(range, '2026-11-01')).toBe('expired');
    expect(
      priceStatus({ validFrom: '2026-01-01', validTo: null }, '2099-01-01'),
    ).toBe('current');
  });

  it('priceOn picks the row in effect', () => {
    const rows = [
      { id: 'a', validFrom: '2026-01-01', validTo: '2026-09-30' },
      { id: 'b', validFrom: '2026-10-01', validTo: null },
    ];
    expect(priceOn(rows, '2026-09-30')?.id).toBe('a');
    expect(priceOn(rows, '2026-10-01')?.id).toBe('b');
    expect(priceOn(rows, '2025-12-31')).toBeNull();
  });

  it('cleanPrice normalises and defaults the currency to THB', () => {
    expect(
      cleanPrice({
        productCode: ' SIP-TRUNK ',
        unitPrice: 1234.567,
        validFrom: '2026-10-01',
        validTo: '',
        note: ' ราคาปี 2570 ',
      }),
    ).toEqual({
      ok: true,
      value: {
        productCode: 'SIP-TRUNK',
        priceModel: 'unit',
        currency: 'THB',
        unitPrice: 1234.57,
        validFrom: '2026-10-01',
        validTo: null,
        note: 'ราคาปี 2570',
      },
    });
    expect(
      cleanPrice({
        productCode: 'X',
        currency: 'usd',
        unitPrice: 0,
        validFrom: '2026-10-01',
      }),
    ).toMatchObject({ ok: true, value: { currency: 'USD', unitPrice: 0 } });
  });

  it('cleanPrice reports every problem at once', () => {
    expect(
      cleanPrice({
        currency: 'baht',
        unitPrice: -1,
        validFrom: '2026-10-05',
        validTo: '2026-10-01',
      }),
    ).toEqual({
      ok: false,
      problems: [
        { field: 'product_code', reason: 'required' },
        { field: 'currency', reason: 'invalid' },
        { field: 'unit_price', reason: 'invalid' },
        { field: 'valid_to', reason: 'before_valid_from' },
      ],
    });
    expect(isIsoDate('2026-02-30')).toBe(false);
  });
});

describe('price versions (CD-195)', () => {
  const base = {
    productCode: 'X',
    priceModel: 'unit' as const,
    currency: 'THB',
    unitPrice: 100,
    validFrom: '2026-01-01',
    validTo: null,
    note: '',
  };

  it('dayBefore crosses months and years', () => {
    expect(dayBefore('2026-03-01')).toBe('2026-02-28');
    expect(dayBefore('2027-01-01')).toBe('2026-12-31');
  });

  it('a started price may only change its end, not into the past', () => {
    expect(hasStarted(base, '2026-01-01')).toBe(true);
    expect(hasStarted(base, '2025-12-31')).toBe(false);
    expect(
      startedEditProblems(
        base,
        { ...base, validTo: '2026-09-29' },
        '2026-09-30',
      ),
    ).toEqual([]);
    expect(
      startedEditProblems(
        base,
        { ...base, unitPrice: 120, validTo: '2026-09-01' },
        '2026-09-30',
      ),
    ).toEqual([
      { field: 'unit_price', reason: 'locked_after_start' },
      { field: 'valid_to', reason: 'before_yesterday' },
    ]);
  });

  it('a revision starts today or later, inside the old range', () => {
    const range = { validFrom: '2026-01-01', validTo: '2026-12-31' };
    expect(revisionProblems(range, '2026-10-01', '2026-09-30')).toEqual([]);
    expect(revisionProblems(range, '2026-09-29', '2026-09-30')).toEqual([
      { field: 'effective_from', reason: 'in_the_past' },
    ]);
    expect(revisionProblems(range, '2027-01-01', '2026-09-30')).toEqual([
      { field: 'effective_from', reason: 'after_end' },
    ]);
    expect(
      revisionProblems(
        { validFrom: '2026-10-05', validTo: null },
        '2026-10-05',
        '2026-09-30',
      ),
    ).toEqual([{ field: 'effective_from', reason: 'not_after_start' }]);
  });
});

describe('special prices (CD-197)', () => {
  it('a standard price needs no target; a special one needs a target and an end', () => {
    expect(cleanTarget(undefined, undefined, null)).toEqual({
      ok: true,
      value: { scope: 'standard', targetId: null },
    });
    expect(cleanTarget('customer', 'c-1', '2026-12-31')).toEqual({
      ok: true,
      value: { scope: 'customer', targetId: 'c-1' },
    });
    expect(cleanTarget('segment', '', null)).toEqual({
      ok: false,
      problems: [
        { field: 'target_id', reason: 'required' },
        { field: 'valid_to', reason: 'required_for_special_price' },
      ],
    });
    expect(cleanTarget('vip', 'x', '2026-12-31')).toMatchObject({ ok: false });
  });

  it('deal > customer > group > standard; the cheapest group price wins', () => {
    const rows = [
      { id: 'std', scope: 'standard' as const, unitPrice: 1000 },
      { id: 'seg-a', scope: 'segment' as const, unitPrice: 900 },
      { id: 'seg-b', scope: 'segment' as const, unitPrice: 850 },
    ];
    expect(pickApplicable(rows)?.id).toBe('seg-b');
    expect(
      pickApplicable([
        ...rows,
        { id: 'cust', scope: 'customer' as const, unitPrice: 950 },
      ])?.id,
    ).toBe('cust');
    expect(
      pickApplicable([
        ...rows,
        { id: 'cust', scope: 'customer' as const, unitPrice: 950 },
        { id: 'deal', scope: 'opportunity' as const, unitPrice: 990 },
      ])?.id,
    ).toBe('deal');
    expect(pickApplicable([])).toBeNull();
  });
});
