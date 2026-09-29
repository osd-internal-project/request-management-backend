import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  SOP_DOCREQ_FLOW,
  SOP_DOCREQ_FORM,
} from '../../../../libs/prisma/sop-docreq-flow';
import { PublishFlowDto } from './dto/request.dto';
import { flowFromDto, knownFields } from './request-flow-admin.service';
import { nextForward } from './request-flow';
import { assertPublishableV2 } from './request-flow-v2';
import { assertUsableFormSchema } from './submit-rules';

// `yarn sop:seed` writes these rows directly, so this is the publish API's check standing in.
describe('SOP_DOCREQ flow (seed-sop-docreq-type.ts)', () => {
  const dto: PublishFlowDto = SOP_DOCREQ_FLOW;
  const flow = flowFromDto(dto);

  it('is a valid PublishFlowDto body', () => {
    const errors = validateSync(plainToInstance(PublishFlowDto, dto), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    expect(errors).toEqual([]);
  });

  it('passes the v2 publish checks', () => {
    expect(() =>
      assertPublishableV2(flow, knownFields(SOP_DOCREQ_FORM, dto)),
    ).not.toThrow();
  });

  it('has usable forms on the type and on every step', () => {
    expect(() => assertUsableFormSchema(SOP_DOCREQ_FORM)).not.toThrow();
    for (const step of dto.steps) {
      if (step.form_schema) {
        expect(() => assertUsableFormSchema(step.form_schema)).not.toThrow();
      }
    }
  });

  it('checks the certificate only when the custodian confirms one was asked for', () => {
    expect(nextForward(flow, 'PREPARE', { cert_requested: true })).toBe(
      'CERT_CHECK',
    );
    expect(nextForward(flow, 'PREPARE', { cert_requested: false })).toBe(
      'STAMP_DELIVER',
    );
    // The requester's own tick does not decide the branch.
    expect(
      nextForward(flow, 'PREPARE', {
        includes_company_cert: true,
        cert_requested: false,
      }),
    ).toBe('STAMP_DELIVER');
  });

  it('reissues the certificate when its date cannot cover the use date', () => {
    expect(nextForward(flow, 'CERT_CHECK', { cert_usable: false })).toBe(
      'CERT_REISSUE',
    );
    expect(nextForward(flow, 'CERT_CHECK', { cert_usable: true })).toBe(
      'STAMP_DELIVER',
    );
    expect(nextForward(flow, 'CERT_REISSUE', {})).toBe('STAMP_DELIVER');
  });

  it('closes from the requester step that demands the signed document', () => {
    const last = flow.steps.find((step) => step.code === 'SIGNED_CONFIRM');
    expect(last?.scopeStatus).toBe('approved');
    expect(last?.requiredDocs).toEqual([
      {
        code: 'SIGNED_DOCUMENT',
        name: 'เอกสารที่ลงนามเรียบร้อย',
        required: true,
      },
    ]);
    expect(nextForward(flow, 'SIGNED_CONFIRM', {})).toBeNull();
  });
});
