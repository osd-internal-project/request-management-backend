import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ReturnRequestDto, UpdateRequestTypeDto } from './dto/request.dto';

/** Every failing field, the way `ValidationPipe` would collect them. */
function fieldsRejecting(dto: object): string[] {
  return validateSync(dto, { whitelist: true })
    .flatMap((error) => [
      error.property,
      ...(error.children ?? []).flatMap((child) =>
        Object.keys(child.children?.[0]?.constraints ?? {}).length
          ? [`${error.property}[].${child.children?.[0]?.property ?? ''}`]
          : [],
      ),
    ])
    .filter(Boolean);
}

/**
 * The 400 the A2 screen hit on 1 ก.ย. 2569, pinned so it cannot come back.
 *
 * `returnReasonCodes` was seeded as `{ code, label }` while `CodedLabelDto`
 * requires `{ code, name }`. A2 loaded a seeded type, sent the entries back
 * untouched on save, and the request was rejected before it reached the
 * service — with `Bad Request Exception`, which names nothing. Neither seeded
 * type could be edited at all.
 *
 * Written against the DTO rather than through HTTP because the DTO is where
 * the refusal happened, and this way the rule is checked on every run instead
 * of only when somebody opens the screen.
 */
describe('A2 can save a type whose coded lists came from the seed', () => {
  const payload = {
    name: 'ขอส่วนลด',
    required_docs: [{ code: 'QUOTE_DRAFT', name: 'ใบเสนอราคาฉบับร่าง' }],
    return_reason_codes: [
      { code: 'DOC_INCOMPLETE', name: 'เอกสารไม่ครบ' },
      { code: 'OTHER', name: 'อื่น ๆ (ระบุ)' },
    ],
  };

  it('accepts the shape the screen sends', () => {
    const dto = plainToInstance(UpdateRequestTypeDto, payload);

    expect(fieldsRejecting(dto)).toEqual([]);
  });

  /**
   * The exact payload that produced the reported failure. Kept as a negative
   * so the reason the migration exists stays legible: `label` is not a second
   * accepted spelling, it is the shape that was migrated away.
   */
  it('still refuses the old `label` spelling, naming the field', () => {
    const dto = plainToInstance(UpdateRequestTypeDto, {
      ...payload,
      return_reason_codes: [{ code: 'DOC_INCOMPLETE', label: 'เอกสารไม่ครบ' }],
    });

    expect(fieldsRejecting(dto)).toContain('return_reason_codes[].name');
  });

  /** `[]` reopens the type to every group — a value, not an omission. */
  it('accepts an empty coded list', () => {
    const dto = plainToInstance(UpdateRequestTypeDto, {
      ...payload,
      return_reason_codes: [],
    });

    expect(fieldsRejecting(dto)).toEqual([]);
  });
});

/**
 * REQ-04 — the other half of the same drift.
 *
 * `request-actions.tsx` sent `{ reason_codes: [] }`, a field the API has never
 * had, so every return of a request that was not awaiting approval answered
 * 400. The client wrapper declared that wrong shape faithfully, which is why
 * the compiler had nothing to object to.
 */
describe('REQ-04 return names one code, not a list', () => {
  it('accepts a single code with a note', () => {
    const dto = plainToInstance(ReturnRequestDto, {
      reason_code: 'DOC_INCOMPLETE',
      note: 'ขาดใบเสนอราคา',
    });

    expect(fieldsRejecting(dto)).toEqual([]);
  });

  it('refuses the plural field the screen used to send', () => {
    const dto = plainToInstance(ReturnRequestDto, {
      reason_codes: [],
      note: 'ขาดใบเสนอราคา',
    });

    expect(fieldsRejecting(dto)).toContain('reason_code');
  });

  it('refuses an empty code', () => {
    const dto = plainToInstance(ReturnRequestDto, {
      reason_code: '',
      note: 'ขาดใบเสนอราคา',
    });

    expect(fieldsRejecting(dto)).toContain('reason_code');
  });
});
