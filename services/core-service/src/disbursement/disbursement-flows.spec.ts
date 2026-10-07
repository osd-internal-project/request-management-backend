import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  DISBURSEMENT_BINDINGS,
  disbursementFlow,
  requiredBindings,
  VERIFY_FORM,
  withDisbursementBindings,
} from '../../../../libs/prisma/disbursement-flows';
import { missingBindings, readBound } from '../requests/form-binding';
import { PublishFlowDto } from '../requests/dto/request.dto';
import {
  flowFromDto,
  knownFields,
} from '../requests/request-flow-admin.service';
import { nextForward } from '../requests/request-flow';
import { assertPublishableV2 } from '../requests/request-flow-v2';
import { assertUsableFormSchema } from '../requests/submit-rules';

/** Shaped like the FI05 form `seed-petty-cash-type.ts` writes, before any tag is added. */
const FORM = {
  type: 'object',
  required: ['purpose'],
  properties: {
    purpose: { type: 'string', title: 'วัตถุประสงค์' },
    clear_by: { type: 'string', format: 'date', title: 'กำหนดส่งเคลียร์' },
    cost_center: { type: 'string', title: 'Cost Center' },
    expense_items: {
      type: 'array',
      title: 'รายการค่าใช้จ่าย',
      items: {
        type: 'object',
        properties: {
          description: { type: 'string', title: 'รายการ' },
          cost_center: { type: 'string', title: 'Cost Center' },
          amount: { type: 'number', title: 'จำนวนเงิน' },
        },
      },
    },
  },
};

// `yarn disbursement-flow:seed` writes these rows directly; this stands in for the publish API's check.
describe.each(['ADVANCE', 'PETTY_CASH'] as const)('%s ticket flow', (kind) => {
  const dto = disbursementFlow(kind, FORM, 'unit-fac') as PublishFlowDto;
  const flow = flowFromDto(dto);

  it('is a valid PublishFlowDto body', () => {
    const errors = validateSync(plainToInstance(PublishFlowDto, dto), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    expect(errors).toEqual([]);
  });

  it('passes the v2 publish checks', () => {
    expect(() => assertPublishableV2(flow, knownFields(FORM, dto))).not.toThrow();
    expect(() => assertUsableFormSchema(VERIFY_FORM)).not.toThrow();
  });

  it('head and executive approve before accounting receives, then the work step, then DONE', () => {
    expect(nextForward(flow, 'REQUEST', {})).toBe('HEAD');
    expect(nextForward(flow, 'HEAD', {})).toBe('EXEC');
    expect(nextForward(flow, 'EXEC', {})).toBe('RECEIVE');
    expect(nextForward(flow, 'RECEIVE', {})).toBe('DISBURSE');
    expect(nextForward(flow, 'DISBURSE', {})).toBe('DONE');
    expect(nextForward(flow, 'DONE', {})).toBeNull();
  });

  it('has no money step: paying and clearing belong to the disbursement', () => {
    const codes = dto.steps.map((step) => step.code);
    expect(codes).not.toContain('PAY');
    expect(codes).not.toContain('CLEAR');
    expect(dto.steps.at(-1)?.scope_status).toBe('approved');
  });

  it('tags the request form with every binding the disbursement requires', () => {
    expect(missingBindings(dto.steps[0].form_schema, 'disbursement', requiredBindings(kind))).toEqual([]);
  });
});

describe('withDisbursementBindings — the FI05 form as seeded', () => {
  const SEEDED = FORM;
  const tagged = withDisbursementBindings(SEEDED);

  it('makes Cost Center fields pick from the master list, in the header and in each line', () => {
    const props = tagged.properties as Record<string, Record<string, unknown>>;
    expect(props.cost_center['x-options-source']).toBe('cost_centers');
    const cells = (props.expense_items.items as { properties: Record<string, Record<string, unknown>> }).properties;
    expect(cells.cost_center['x-options-source']).toBe('cost_centers');
  });

  it('leaves the input untouched', () => {
    expect(JSON.stringify(SEEDED)).not.toContain('x-bind');
  });

  it('reads the same values through the tags as the old fixed keys did', () => {
    const data = { purpose: 'ออกบูธ', expense_items: [{ description: 'ค่ารถ', amount: 600 }] };
    expect(readBound(tagged, data, 'disbursement', DISBURSEMENT_BINDINGS)).toMatchObject({
      purpose: 'ออกบูธ',
      lines: [{ description: 'ค่ารถ', amount: 600 }],
    });
  });
});
