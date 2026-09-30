import {
  cleanPrice,
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
