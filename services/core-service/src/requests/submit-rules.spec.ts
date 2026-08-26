import { assertKnownReturnReason, assertSubmittable } from './submit-rules';

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
});
