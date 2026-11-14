import {
  bundleKey,
  cleanBundle,
  listedItemsOfLead,
  mandatoryItems,
  productNameOfLead,
  requirementsOfLead,
  type BundleItemState,
} from './product-bundle-rules';

const line: BundleItemState = {
  productCode: 'X',
  quantity: 1,
  termMonths: null,
  optional: false,
  fixedQuantity: false,
};

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
              fixedQuantity: false,
            },
            {
              productCode: 'B-2',
              quantity: 1,
              termMonths: 24,
              optional: true,
              fixedQuantity: false,
            },
          ],
          requirements: [],
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
        { ...line, productCode: 'A-1', quantity: 2 },
        { ...line, productCode: 'B-2', termMonths: 24, optional: true },
        { ...line, productCode: 'C-3', termMonths: 36 },
      ]),
    ).toEqual([
      { product_code: 'A-1', quantity: 2 },
      { product_code: 'C-3', quantity: 1, term_months: 36 },
    ]);
  });

  it('mandatoryItems multiplies by what the customer asked for, except fixed lines (13 พ.ย. 2569)', () => {
    expect(
      mandatoryItems(
        [
          { ...line, productCode: 'PHONE', quantity: 1 },
          { ...line, productCode: 'CABLE', quantity: 2 },
          { ...line, productCode: 'INSTALL', fixedQuantity: true },
        ],
        50,
      ),
    ).toEqual([
      { product_code: 'PHONE', quantity: 50 },
      { product_code: 'CABLE', quantity: 100 },
      { product_code: 'INSTALL', quantity: 1 },
    ]);
  });

  it('cleanBundle keeps the product’s questions, keys them and refuses a reserved or repeated key', () => {
    const items = [{ productCode: 'A-1', quantity: 1 }];
    const ok = cleanBundle({
      name: 'IP-PHONE',
      items,
      requirements: [
        { question: ' สถานที่ติดตั้ง ', hints: ['ติดตั้งที่', ' สาขา ', 'x'] },
        { key: 'term', question: 'ระยะสัญญา' },
      ],
    });
    expect(ok.ok && ok.value.requirements).toEqual([
      { key: 'q1', question: 'สถานที่ติดตั้ง', hints: ['ติดตั้งที่', 'สาขา'] },
      { key: 'term', question: 'ระยะสัญญา', hints: [] },
    ]);
    const bad = cleanBundle({
      name: 'IP-PHONE',
      items,
      requirements: [
        { key: 'quantity', question: 'กี่เครื่อง' },
        { key: 'a', question: '' },
      ],
    });
    expect(!bad.ok && bad.problems).toEqual([
      { field: 'requirements[0].key', reason: 'duplicate' },
      { field: 'requirements[1].question', reason: 'required' },
    ]);
  });

  it('requirementsOfLead reads what the customer told so far, dropping junk', () => {
    expect(
      requirementsOfLead({
        subProduct: null,
        intakeData: {
          requirements: {
            product: ' IP-PHONE ',
            quantity: '50',
            answers: { site: 'ระยอง', empty: ' ', n: 3 },
          },
        },
      }),
    ).toEqual({
      product: 'IP-PHONE',
      quantity: 50,
      answers: { site: 'ระยอง' },
    });
    expect(requirementsOfLead({ subProduct: null, intakeData: null })).toEqual({
      product: null,
      quantity: null,
      answers: {},
    });
  });
});
