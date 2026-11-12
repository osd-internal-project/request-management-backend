import {
  bundleKey,
  cleanBundle,
  listedItemsOfLead,
  mandatoryItems,
  productNameOfLead,
} from './product-bundle-rules';

describe('product bundle rules', () => {
  it('bundleKey ignores case and stray spaces', () => {
    expect(bundleKey('  D-Debt   Pro ')).toBe('d-debt pro');
  });

  describe('cleanBundle', () => {
    const item = { productCode: 'A-1', quantity: 2 };

    it('keeps a tidy bundle', () => {
      const cleaned = cleanBundle({
        name: ' IP  Phone ',
        note: ' ชุดเริ่มต้น ',
        items: [item, { productCode: 'B-2', termMonths: 24, optional: true }],
      });
      expect(cleaned).toEqual({
        ok: true,
        value: {
          name: 'IP Phone',
          note: 'ชุดเริ่มต้น',
          active: true,
          items: [
            {
              productCode: 'A-1',
              quantity: 2,
              termMonths: null,
              optional: false,
            },
            { productCode: 'B-2', quantity: 1, termMonths: 24, optional: true },
          ],
        },
      });
    });

    it('refuses no name, no items and a repeated item', () => {
      const cleaned = cleanBundle({ name: ' ', items: [] });
      expect(cleaned.ok).toBe(false);
      expect(cleaned.ok ? [] : cleaned.problems).toEqual([
        { field: 'name', reason: 'required' },
        { field: 'items', reason: 'required' },
      ]);

      const repeated = cleanBundle({ name: 'X', items: [item, item] });
      expect(repeated.ok ? [] : repeated.problems).toEqual([
        { field: 'items[1].product_code', reason: 'duplicate' },
      ]);
    });

    it('refuses a quantity or term out of range', () => {
      const cleaned = cleanBundle({
        name: 'X',
        items: [{ productCode: 'A-1', quantity: 0, termMonths: 0 }],
      });
      expect(cleaned.ok ? [] : cleaned.problems).toEqual([
        { field: 'items[0].quantity', reason: 'out_of_range' },
        { field: 'items[0].term_months', reason: 'out_of_range' },
      ]);
    });

    it('refuses a bundle with only optional items', () => {
      const cleaned = cleanBundle({
        name: 'X',
        items: [{ ...item, optional: true }],
      });
      expect(cleaned.ok ? [] : cleaned.problems).toEqual([
        { field: 'items', reason: 'no_mandatory_item' },
      ]);
    });
  });

  it('listedItemsOfLead reads either shape and keeps the term', () => {
    expect(
      listedItemsOfLead({
        subProduct: 'IGNORED',
        intakeData: {
          products: [
            { product_code: 'A-1', quantity: 3, term_months: 24 },
            { code: 'B-2', qty: '2', term_months: 0 },
            'C-3',
            { name: 'no code' },
          ],
        },
      }),
    ).toEqual([
      { product_code: 'A-1', quantity: 3, term_months: 24 },
      { product_code: 'B-2', quantity: 2 },
      { product_code: 'C-3', quantity: 1 },
    ]);
    expect(listedItemsOfLead({ subProduct: 'X', intakeData: null })).toEqual(
      [],
    );
    expect(listedItemsOfLead(null)).toEqual([]);
  });

  it('productNameOfLead prefers the picked product over Sub Product', () => {
    expect(
      productNameOfLead({
        subProduct: 'IP-PHONE',
        intakeData: { selected_product: ' D-DEBT ' },
      }),
    ).toBe('D-DEBT');
    expect(
      productNameOfLead({ subProduct: ' IP-PHONE ', intakeData: {} }),
    ).toBe('IP-PHONE');
    expect(
      productNameOfLead({ subProduct: null, intakeData: null }),
    ).toBeNull();
  });

  it('mandatoryItems leaves the optional ones out', () => {
    expect(
      mandatoryItems([
        { productCode: 'A-1', quantity: 2, termMonths: null, optional: false },
        { productCode: 'B-2', quantity: 1, termMonths: 24, optional: true },
        { productCode: 'C-3', quantity: 1, termMonths: 36, optional: false },
      ]),
    ).toEqual([
      { product_code: 'A-1', quantity: 2 },
      { product_code: 'C-3', quantity: 1, term_months: 36 },
    ]);
  });
});
