import type { AppError, ErrorDetail } from '@request-management/share';
import {
  assertKnownReturnReason,
  assertReceiverFormComplete,
  assertSubmittable,
  assertUsableFormSchema,
} from './submit-rules';

const SCHEMA = {
  type: 'object',
  required: ['customer_name', 'deal_value', 'discount_pct', 'reason'],
  properties: {
    customer_name: { type: 'string', title: 'ลูกค้า' },
    deal_value: { type: 'number', title: 'มูลค่าดีล (บาท)' },
    discount_pct: { type: 'number', title: 'ส่วนลด (%)' },
    reason: { type: 'string', title: 'เหตุผล' },
  },
};

const DOCS = [{ code: 'QUOTE_DRAFT', name: 'ใบเสนอราคาฉบับร่าง' }];

const COMPLETE = {
  customer_name: 'บจก. ตัวอย่าง',
  deal_value: 800000,
  discount_pct: 12.5,
  reason: 'ลูกค้าได้ข้อเสนอจากคู่แข่งต่ำกว่า',
};

function submit(
  formData: Record<string, unknown>,
  attachmentCodes: string[] = ['QUOTE_DRAFT'],
) {
  return () =>
    assertSubmittable({
      formSchema: SCHEMA,
      requiredDocs: DOCS,
      formData,
      attachmentCodes,
    });
}

describe('REQ-03 what blocks a submit', () => {
  it('allows a complete request', () => {
    expect(submit(COMPLETE)).not.toThrow();
  });

  it('names the missing field, not just "invalid"', () => {
    expect(submit({ ...COMPLETE, reason: undefined })).toThrow(
      expect.objectContaining({
        code: 'REQ_FIELD_MISSING',
        details: [{ field: 'reason', reason: 'เหตุผล' }],
      }),
    );
  });

  /**
   * Reporting one problem at a time turns filling in a form into a guessing
   * game — the user fixes a field only to be told about the next one.
   */
  it('reports every missing field at once', () => {
    try {
      submit({ reason: 'x' })();
      throw new Error('should have thrown');
    } catch (thrown) {
      const details = (thrown as { details: { field: string }[] }).details;
      expect(details.map((detail) => detail.field).sort()).toEqual([
        'customer_name',
        'deal_value',
        'discount_pct',
      ]);
    }
  });

  it('treats an empty or whitespace string as missing', () => {
    expect(submit({ ...COMPLETE, customer_name: '' })).toThrow();
    expect(submit({ ...COMPLETE, customer_name: '   ' })).toThrow();
  });

  /** A 0% discount and `false` are answers, not absences. */
  it('accepts 0 and false as real values', () => {
    expect(submit({ ...COMPLETE, discount_pct: 0 })).not.toThrow();
  });

  it('blocks when a required document is not attached', () => {
    expect(submit(COMPLETE, [])).toThrow(
      expect.objectContaining({
        code: 'REQ_DOC_MISSING',
        details: [{ field: 'attachments', reason: 'ใบเสนอราคาฉบับร่าง' }],
      }),
    );
  });

  it('names the document, so the user knows what to attach', () => {
    try {
      submit(COMPLETE, [])();
      throw new Error('should have thrown');
    } catch (thrown) {
      expect((thrown as { message: string }).message).toContain('เอกสาร');
    }
  });

  it('allows a type with no required fields or documents', () => {
    expect(() =>
      assertSubmittable({
        formSchema: { type: 'object' },
        requiredDocs: [],
        formData: {},
        attachmentCodes: [],
      }),
    ).not.toThrow();
  });
});

/**
 * `อ้างอิงดีล` — a rule of the type, checked by the server.
 *
 * §16 marks the field required on the DSC mockup, and the submit screen turned
 * that into a rule for all 45 types, blocking anything with no deal to point
 * at. The rule also lived *only* on the screen, so any caller could skip it —
 * ROLE-01 says the screen is convenience, never control.
 */
describe('REQ-03 the deal reference is required per type', () => {
  const base = {
    formSchema: SCHEMA,
    requiredDocs: DOCS,
    formData: COMPLETE,
    attachmentCodes: ['QUOTE_DRAFT'],
  };

  it('lets a type that does not ask for one through without it', () => {
    expect(() =>
      assertSubmittable({ ...base, refRequired: false, refId: null }),
    ).not.toThrow();
  });

  it('says nothing about it when the type is silent', () => {
    expect(() => assertSubmittable(base)).not.toThrow();
  });

  it('refuses a type that asks for one when it is missing', () => {
    expect.assertions(2);

    try {
      assertSubmittable({ ...base, refRequired: true, refId: null });
    } catch (error) {
      expect((error as AppError).code).toBe('REQ_FIELD_MISSING');
      expect((error as AppError).details).toEqual([
        { field: 'ref_id', reason: 'อ้างอิงดีล' },
      ]);
    }
  });

  /** Whitespace is not an answer, the same way it is not for any other field. */
  it('refuses a blank string as a reference', () => {
    expect(() =>
      assertSubmittable({ ...base, refRequired: true, refId: '   ' }),
    ).toThrow(expect.objectContaining({ code: 'REQ_FIELD_MISSING' }));
  });

  it('accepts a type that asks for one when it is given', () => {
    expect(() =>
      assertSubmittable({ ...base, refRequired: true, refId: 'D-501' }),
    ).not.toThrow();
  });
});

describe('REQ-04 return reasons must come from the type list', () => {
  const REASONS = [
    { code: 'DOC_INCOMPLETE', name: 'เอกสารไม่ครบ' },
    { code: 'PRICE_UNCLEAR', name: 'ราคาไม่ชัดเจน' },
  ];

  it('accepts a code from the list', () => {
    expect(() =>
      assertKnownReturnReason(REASONS, 'DOC_INCOMPLETE'),
    ).not.toThrow();
  });

  /**
   * The list is the point: bounce causes have to be countable, and an
   * arbitrary code is a category of one.
   */
  it('refuses a code that is not on the list', () => {
    expect(() => assertKnownReturnReason(REASONS, 'BECAUSE_I_SAID_SO')).toThrow(
      expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    );
  });

  it('refuses anything when the type declares no reasons', () => {
    expect(() => assertKnownReturnReason([], 'DOC_INCOMPLETE')).toThrow();
  });

  /**
   * The old `{ code, label }` shape, which is what a request raised before
   * 1 ก.ย. 2569 still carries in its `typeSnapshot`.
   *
   * The migration that renamed the key deliberately left snapshots alone — a
   * snapshot is the rule the request was raised under (§7). That is only safe
   * if validation reads the code and nothing else, so this test is what makes
   * "safe" a fact rather than an assumption: an old request must still be
   * returnable with its own reasons.
   */
  it('still accepts a snapshot written before the key was renamed', () => {
    const legacy = [
      { code: 'DOC_INCOMPLETE', label: 'เอกสารไม่ครบ' },
      { code: 'OTHER', label: 'อื่น ๆ (ระบุ)' },
    ];

    expect(() =>
      assertKnownReturnReason(legacy, 'DOC_INCOMPLETE'),
    ).not.toThrow();
    expect(() => assertKnownReturnReason(legacy, 'NOT_LISTED')).toThrow(
      expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    );
  });

  /**
   * What the message says when the name is missing. The codes are listed back
   * to the caller, so a nameless entry still names itself — it is never
   * `undefined` in the error a person reads.
   */
  it('names an entry by its code when it carries no readable name', () => {
    expect.assertions(1);

    try {
      assertKnownReturnReason([{ code: 'DOC_INCOMPLETE' }], 'NOT_LISTED');
    } catch (error) {
      expect((error as AppError).details).toEqual([
        { field: 'reason_code', reason: 'ต้องเป็นหนึ่งใน: DOC_INCOMPLETE' },
      ]);
    }
  });
});

describe('H2.2 ข้อ 3: the receiver fills in their own form before finishing', () => {
  const schema = {
    type: 'object',
    required: ['outcome', 'cost'],
    properties: {
      outcome: { type: 'string', title: 'ผลการดำเนินการ' },
      cost: { type: 'number', title: 'ค่าใช้จ่าย' },
    },
  };

  it('asks for nothing when the type has no second form', () => {
    expect(() => assertReceiverFormComplete(null, {})).not.toThrow();
    expect(() => assertReceiverFormComplete(undefined, {})).not.toThrow();
  });

  it('passes once every required field is answered', () => {
    expect(() =>
      assertReceiverFormComplete(schema, { outcome: 'ทำแล้ว', cost: 0 }),
    ).not.toThrow();
  });

  /**
   * Zero is an answer. `isBlank` treats `0` and `false` as present for the
   * requester's form and has to here too, or every field costing nothing would
   * be reported as unfilled.
   */
  it('counts zero as an answer', () => {
    expect(() =>
      assertReceiverFormComplete(schema, { outcome: 'ทำแล้ว', cost: 0 }),
    ).not.toThrow();
  });

  it('names every missing field at once, not the first', () => {
    try {
      assertReceiverFormComplete(schema, {});
      throw new Error('expected the form to be refused');
    } catch (error) {
      const failure = error as AppError;
      expect(failure.code).toBe('REQ_FIELD_MISSING');
      expect(failure.details).toHaveLength(2);
    }
  });

  /** A distinct message: this is not the submit form, and saying so saves a hunt. */
  it('says which form is incomplete', () => {
    try {
      assertReceiverFormComplete(schema, { outcome: 'ทำแล้ว' });
      throw new Error('expected the form to be refused');
    } catch (error) {
      expect((error as AppError).message).toContain('ฟอร์มผู้รับคำขอ');
    }
  });
});

/**
 * A `type: 'array'` field is a table: `items` carries the columns, `maxItems`
 * caps the rows. Plain JSON Schema — the vocabulary this file already reads.
 */
describe('a table field is checked row by row', () => {
  const LINES = {
    type: 'object',
    required: ['lines'],
    properties: {
      lines: {
        type: 'array',
        title: 'รายการ',
        maxItems: 3,
        items: {
          type: 'object',
          required: ['item_name', 'qty'],
          properties: {
            item_name: { type: 'string', title: 'รายการ' },
            qty: { type: 'number', title: 'จำนวน' },
          },
        },
      },
    },
  };

  function submitTable(lines: unknown) {
    return () =>
      assertSubmittable({
        formSchema: LINES,
        requiredDocs: [],
        formData: { lines },
        attachmentCodes: [],
      });
  }

  it('accepts rows that carry every required column', () => {
    expect(
      submitTable([
        { item_name: 'ป้ายไวนิล', qty: 2 },
        { item_name: 'โปสเตอร์', qty: 10 },
      ]),
    ).not.toThrow();
  });

  /** A required table with no rows is the `required` rule, not a row rule. */
  it('treats an empty table as a missing required field', () => {
    expect(submitTable([])).toThrow(
      expect.objectContaining({
        code: 'REQ_FIELD_MISSING',
        details: [{ field: 'lines', reason: 'รายการ' }],
      }),
    );
  });

  /**
   * The row index and the column, not just "lines". A table can be long, and
   * being told only that something in it is missing is the slowest possible
   * way to fix it — the same reasoning as reporting every field at once.
   */
  it('names the row and the column that is blank', () => {
    expect.assertions(1);

    try {
      submitTable([
        { item_name: 'ป้ายไวนิล', qty: 2 },
        { item_name: '', qty: 10 },
        { item_name: 'ธง', qty: null },
      ])();
    } catch (error) {
      expect((error as AppError).details).toEqual([
        { field: 'lines[1].item_name', reason: 'รายการ' },
        { field: 'lines[2].qty', reason: 'จำนวน' },
      ]);
    }
  });

  /** 0 is an answer, in a table cell as much as anywhere else. */
  it('accepts 0 in a numeric column', () => {
    expect(submitTable([{ item_name: 'ตัวอย่าง', qty: 0 }])).not.toThrow();
  });

  it('refuses more rows than the cap the admin set', () => {
    expect(
      submitTable([
        { item_name: 'a', qty: 1 },
        { item_name: 'b', qty: 1 },
        { item_name: 'c', qty: 1 },
        { item_name: 'd', qty: 1 },
      ]),
    ).toThrow(
      expect.objectContaining({
        details: [{ field: 'lines', reason: 'เกิน 3 แถว' }],
      }),
    );
  });

  it('lets a table with no cap grow', () => {
    const uncapped = {
      ...LINES,
      properties: {
        lines: { ...LINES.properties.lines, maxItems: undefined },
      },
    };

    expect(() =>
      assertSubmittable({
        formSchema: uncapped,
        requiredDocs: [],
        formData: {
          lines: Array.from({ length: 40 }, () => ({
            item_name: 'x',
            qty: 1,
          })),
        },
        attachmentCodes: [],
      }),
    ).not.toThrow();
  });
});

describe('REQ-01 a table an admin authors must be one the screen can draw', () => {
  function author(lines: Record<string, unknown>) {
    return () =>
      assertUsableFormSchema({
        type: 'object',
        properties: { lines: { type: 'array', title: 'รายการ', ...lines } },
      });
  }

  it('accepts a table with columns', () => {
    expect(
      author({
        items: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string', title: 'ชื่อ' } },
        },
      }),
    ).not.toThrow();
  });

  it('refuses a table with no columns — it would render empty', () => {
    expect(author({ items: { type: 'object', properties: {} } })).toThrow(
      expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    );
    expect(author({})).toThrow();
  });

  it('refuses a required column that does not exist', () => {
    expect.assertions(1);

    try {
      author({
        items: {
          type: 'object',
          required: ['ghost'],
          properties: { name: { type: 'string' } },
        },
      })();
    } catch (error) {
      expect((error as AppError).details).toContainEqual({
        field: 'form_schema.lines.items.required',
        reason: '"ghost" ไม่มีอยู่ในคอลัมน์ของตาราง',
      });
    }
  });

  /** Nothing downstream can draw or mask a second level — see `unusableTables`. */
  it('refuses a table inside a table', () => {
    expect.assertions(1);

    try {
      author({
        items: {
          type: 'object',
          properties: { inner: { type: 'array', items: { type: 'object' } } },
        },
      })();
    } catch (error) {
      expect((error as AppError).details).toContainEqual({
        field: 'form_schema.lines.items.inner',
        reason: 'ตารางซ้อนในตารางไม่รองรับ',
      });
    }
  });

  it('refuses a row cap that is not a whole number of rows', () => {
    const columns = {
      items: { type: 'object', properties: { name: { type: 'string' } } },
    };

    expect(author({ ...columns, maxItems: 0 })).toThrow();
    expect(author({ ...columns, maxItems: 2.5 })).toThrow();
    expect(author({ ...columns, maxItems: 1 })).not.toThrow();
  });
});

/*
  REQ-03's other half, added 9 ก.ย. 2569. Until then a submit checked only that
  required fields were non-empty; `enum`, `type`, `format`, `maxLength` and the
  numeric bounds were declared in every schema and read by nobody.
*/
describe('REQ-03 — an answer that is present but not allowed', () => {
  const schema = {
    required: ['subject'],
    properties: {
      subject: { type: 'string', title: 'เรื่อง', maxLength: 10 },
      priority: {
        type: 'string',
        title: 'ความเร่งด่วน',
        enum: ['LOW', 'HIGH'],
      },
      amount: { type: 'number', title: 'จำนวนเงิน', minimum: 0, maximum: 100 },
      count: { type: 'integer', title: 'จำนวน' },
      urgent: { type: 'boolean', title: 'ด่วน' },
      needed_by: { type: 'string', title: 'ต้องการภายใน', format: 'date' },
    },
  };

  const submit = (formData: Record<string, unknown>) => () =>
    assertSubmittable({
      formSchema: schema,
      requiredDocs: [],
      formData: { subject: 'ok', ...formData },
      attachmentCodes: [],
    });

  const detailsOf = (run: () => void): readonly ErrorDetail[] => {
    try {
      run();
    } catch (error) {
      return (error as AppError).details ?? [];
    }

    throw new Error('expected assertSubmittable to reject');
  };

  it('rejects a value outside the enum and names the choices', () => {
    const [detail] = detailsOf(submit({ priority: 'ด่วนสุด ๆ' }));

    expect(detail.field).toBe('priority');
    expect(detail.reason).toContain('LOW / HIGH');
  });

  it('rejects a number sent as a string — the OSD `deal_value` defect', () => {
    expect(detailsOf(submit({ amount: '80' }))).toEqual([
      { field: 'amount', reason: 'จำนวนเงิน: ต้องเป็นตัวเลข' },
    ]);
  });

  it('enforces the numeric bounds the schema declares', () => {
    expect(detailsOf(submit({ amount: 101 }))[0].reason).toContain(
      'ไม่เกิน 100',
    );
    expect(detailsOf(submit({ amount: -1 }))[0].reason).toContain(
      'ไม่น้อยกว่า 0',
    );
  });

  it('rejects a fraction where the schema asked for a whole number', () => {
    expect(detailsOf(submit({ count: 1.5 }))[0].reason).toContain('จำนวนเต็ม');
  });

  it('rejects a string where the schema asked for a boolean', () => {
    expect(detailsOf(submit({ urgent: 'true' }))[0].reason).toContain(
      'true หรือ false',
    );
  });

  it('rejects a date that is not ปปปป-ดด-วว', () => {
    expect(detailsOf(submit({ needed_by: 'อาทิตย์หน้า' }))[0].reason).toContain(
      'ปปปป-ดด-วว',
    );
  });

  /*
    The pattern alone accepts 31 February. Round-tripping through `Date` is what
    rejects it, and it is the case a regex-only check always misses.
  */
  it('rejects a date that matches the pattern but does not exist', () => {
    expect(detailsOf(submit({ needed_by: '2026-02-31' }))[0].field).toBe(
      'needed_by',
    );
  });

  it('accepts a real date', () => {
    expect(submit({ needed_by: '2026-09-15' })).not.toThrow();
  });

  it('rejects a string longer than maxLength', () => {
    expect(
      detailsOf(() =>
        assertSubmittable({
          formSchema: schema,
          requiredDocs: [],
          formData: { subject: 'ยาวเกินสิบตัวอักษรแน่นอน' },
          attachmentCodes: [],
        }),
      )[0].reason,
    ).toContain('ยาวเกิน 10');
  });

  it('leaves an empty optional field alone — absent is not wrong', () => {
    expect(
      submit({ priority: '', amount: null, needed_by: undefined }),
    ).not.toThrow();
  });

  it('accepts 0 and false, which are answers rather than blanks', () => {
    expect(submit({ amount: 0, urgent: false })).not.toThrow();
  });

  it('reports every problem at once, missing and invalid together', () => {
    const details = detailsOf(() =>
      assertSubmittable({
        formSchema: schema,
        requiredDocs: [],
        formData: { priority: 'นะจ๊ะ', amount: '5' },
        attachmentCodes: [],
      }),
    );

    expect(details.map((detail) => detail.field).sort()).toEqual([
      'amount',
      'priority',
      'subject',
    ]);
  });

  it('names the row and column when a table cell is wrong', () => {
    const details = detailsOf(() =>
      assertSubmittable({
        formSchema: {
          properties: {
            lines: {
              type: 'array',
              items: {
                properties: { qty: { type: 'number', title: 'จำนวน' } },
              },
            },
          },
        },
        requiredDocs: [],
        formData: { lines: [{ qty: 1 }, { qty: 'สอง' }] },
        attachmentCodes: [],
      }),
    );

    expect(details).toEqual([
      { field: 'lines[1].qty', reason: 'จำนวน: ต้องเป็นตัวเลข' },
    ]);
  });
});

describe('REQ-08 — the receiver form is checked the same way', () => {
  it('rejects a value outside the enum on complete', () => {
    try {
      assertReceiverFormComplete(
        {
          required: ['result'],
          properties: {
            result: { type: 'string', enum: ['ผ่าน', 'ไม่ผ่าน'] },
          },
        },
        { result: 'ก็งั้น ๆ' },
      );
    } catch (error) {
      expect((error as AppError).code).toBe('REQ_FIELD_MISSING');
      expect((error as AppError).details?.[0].field).toBe('result');
      return;
    }

    throw new Error('expected assertReceiverFormComplete to reject');
  });
});
