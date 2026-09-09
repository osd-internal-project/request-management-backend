import { toFormFields } from './form-schema';

/** A schema shaped like the ones `import-osd-catalog` actually writes. */
const PS01 = {
  type: 'object',
  required: ['subject', 'objective'],
  properties: {
    subject: {
      type: 'string',
      title: 'เรื่องที่ขอ',
      maxLength: 200,
      'x-order': 10,
    },
    objective: {
      type: 'string',
      title: 'วัตถุประสงค์',
      'x-order': 20,
      'x-multiline': true,
    },
    priority: {
      type: 'string',
      title: 'ความเร่งด่วน',
      enum: ['LOW', 'NORMAL', 'HIGH', 'URGENT'],
      'x-order': 80,
    },
    needed_by: {
      type: 'string',
      title: 'ต้องการภายใน',
      format: 'date',
      'x-order': 40,
    },
    amount: {
      type: 'number',
      title: 'จำนวนเงิน',
      minimum: 0,
      maximum: 1000000,
      'x-order': 30,
    },
    margin: {
      type: 'number',
      title: 'มาร์จิน',
      'x-order': 90,
      'x-sensitive': true,
    },
  },
};

describe('REQ-01 — the stored schema, translated for a caller with no renderer', () => {
  it('asks in x-order, not in key order', () => {
    expect(toFormFields(PS01).map((f) => f.key)).toEqual([
      'subject',
      'objective',
      'amount',
      'needed_by',
      'priority',
      'margin',
    ]);
  });

  it('reads required from the schema, not from the property', () => {
    const required = toFormFields(PS01)
      .filter((f) => f.required)
      .map((f) => f.key);

    expect(required).toEqual(['subject', 'objective']);
  });

  /*
    The gap this file was written to close: a chatbot that offered an open
    question here got an answer outside the list, and nothing rejected it.
  */
  it('turns enum into choices a caller can offer', () => {
    const priority = toFormFields(PS01).find((f) => f.key === 'priority');

    expect(priority?.type).toBe('select');
    expect(priority?.options).toEqual([
      { value: 'LOW', label: 'LOW' },
      { value: 'NORMAL', label: 'NORMAL' },
      { value: 'HIGH', label: 'HIGH' },
      { value: 'URGENT', label: 'URGENT' },
    ]);
  });

  it('calls a dated string a date and a long string multiline', () => {
    const fields = toFormFields(PS01);

    expect(fields.find((f) => f.key === 'needed_by')?.type).toBe('date');
    expect(fields.find((f) => f.key === 'objective')?.type).toBe('multiline');
    expect(fields.find((f) => f.key === 'subject')?.type).toBe('text');
  });

  it('carries the bounds a caller has to check before sending', () => {
    const amount = toFormFields(PS01).find((f) => f.key === 'amount');

    expect(amount).toMatchObject({
      type: 'number',
      minimum: 0,
      maximum: 1000000,
    });
    expect(toFormFields(PS01).find((f) => f.key === 'subject')?.maxLength).toBe(
      200,
    );
  });

  it('flags a masked field so a caller can warn before asking (SCOPE-04)', () => {
    expect(toFormFields(PS01).find((f) => f.key === 'margin')?.sensitive).toBe(
      true,
    );
    expect(
      toFormFields(PS01).find((f) => f.key === 'subject')?.sensitive,
    ).toBeUndefined();
  });

  it('falls back to the key when a property has no title', () => {
    const fields = toFormFields({
      properties: { customer_ref: { type: 'string' } },
    });

    expect(fields[0]).toMatchObject({
      key: 'customer_ref',
      label: 'customer_ref',
    });
  });

  it('sorts a field with no x-order after every field that has one', () => {
    const fields = toFormFields({
      properties: {
        zzz: { type: 'string', 'x-order': 1 },
        aaa: { type: 'string' },
      },
    });

    expect(fields.map((f) => f.key)).toEqual(['zzz', 'aaa']);
  });
});

describe('tables', () => {
  const withTable = {
    required: ['lines'],
    properties: {
      lines: {
        type: 'array',
        title: 'รายการ',
        maxItems: 20,
        items: {
          required: ['qty'],
          properties: {
            item: { type: 'string', title: 'รายการ', 'x-order': 1 },
            qty: { type: 'number', title: 'จำนวน', 'x-order': 2 },
          },
        },
      },
    },
  };

  it('describes the columns as fields in their own right', () => {
    const table = toFormFields(withTable)[0];

    expect(table).toMatchObject({ key: 'lines', type: 'table', maxItems: 20 });
    expect(table.columns?.map((c) => c.key)).toEqual(['item', 'qty']);
    expect(table.columns?.find((c) => c.key === 'qty')).toMatchObject({
      type: 'number',
      required: true,
    });
  });
});

describe('a schema that is not usable yet', () => {
  // A type whose form is half-written is the administrator's problem, and the
  // admin screen is where it is fixed. A caller asking what to fill in is told
  // "nothing yet" rather than handed an error it cannot act on.
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'not a schema'],
    ['an object with no properties', { type: 'object' }],
  ])('answers with no fields for %s', (_name, value) => {
    expect(toFormFields(value)).toEqual([]);
  });
});
