import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, of } from 'rxjs';
import {
  Principal,
  SENSITIVE_RESOURCE_KEY,
  SensitiveFieldInterceptor,
  setPrincipal,
} from '@request-management/share';

const RESOURCE = 'request:DSC';

function principalWith(visible: string[]): Principal {
  return {
    userId: 'u_1',
    keycloakId: 'kc_1',
    username: 'somchai.k',
    displayName: 'สมชาย ก.',
    email: null,
    companies: [],
    activeCompanyId: 'c_osd',
    orgUnitId: null,
    supervisorUserId: null,
    ledUnitIds: [],
    roles: [],
    permissions: [],
    sensitiveFieldsVisible: visible,
    sensitiveFieldsAll: [
      `${RESOURCE}.discount_pct`,
      `${RESOURCE}.est_margin_pct`,
    ],
    isServiceAccount: false,
    pendingOrgAssignment: false,
  };
}

function contextFor(principal: Principal): ExecutionContext {
  const request: Record<string, unknown> = { headers: {} };
  setPrincipal(request as never, principal);

  return {
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function interceptorFor(resource: string | undefined, recorder?: unknown) {
  const reflector = {
    getAllAndOverride: (key: string) =>
      key === SENSITIVE_RESOURCE_KEY ? resource : undefined,
  } as unknown as Reflector;

  return new SensitiveFieldInterceptor(reflector, recorder as never);
}

async function run(
  interceptor: SensitiveFieldInterceptor,
  context: ExecutionContext,
  body: unknown,
) {
  return firstValueFrom(
    interceptor.intercept(context, { handle: () => of(body) }),
  );
}

describe('SCOPE-04 sensitive field masking', () => {
  const record = {
    id: 'rq_1',
    customer_name: 'บจก. ตัวอย่าง',
    discount_pct: 12.5,
    est_margin_pct: 18,
  };

  it('removes fields the caller may not see', async () => {
    const result = (await run(
      interceptorFor(RESOURCE),
      contextFor(principalWith([])),
      record,
    )) as Record<string, unknown>;

    expect(result.customer_name).toBe('บจก. ตัวอย่าง');
    expect(result).not.toHaveProperty('discount_pct');
    expect(result).not.toHaveProperty('est_margin_pct');
  });

  /**
   * Deleted, not nulled: a `null` would still confirm the field exists, which
   * is enough to infer that a deal has a margin worth hiding.
   */
  it('deletes rather than nulls, so absence is indistinguishable', async () => {
    const result = (await run(
      interceptorFor(RESOURCE),
      contextFor(principalWith([])),
      record,
    )) as Record<string, unknown>;

    expect('discount_pct' in result).toBe(false);
  });

  it('passes the value through when the caller may see it', async () => {
    const result = (await run(
      interceptorFor(RESOURCE),
      contextFor(principalWith([`${RESOURCE}.est_margin_pct`])),
      record,
    )) as Record<string, unknown>;

    expect(result.est_margin_pct).toBe(18);
    expect(result).not.toHaveProperty('discount_pct');
  });

  /**
   * An approval case binds its decision to `payload`; a request keeps answers
   * in `form_data`. Masking only the top level would leave the value one
   * nesting level away — the exact shape of a leak that looks handled.
   */
  it('masks inside payload, where an approval case carries them', async () => {
    const result = (await run(
      interceptorFor(RESOURCE),
      contextFor(principalWith([])),
      { id: 'ap_1', payload: { deal_value: 800000, est_margin_pct: 18 } },
    )) as { payload: Record<string, unknown> };

    expect(result.payload.deal_value).toBe(800000);
    expect(result.payload).not.toHaveProperty('est_margin_pct');
  });

  /**
   * Prisma returns `formData`; the API contract serialises `form_data`. A
   * request read leaked the margin because only the snake_case spelling was
   * covered — so both are tested.
   */
  it('masks inside formData, the shape Prisma actually returns', async () => {
    const result = (await run(
      interceptorFor(RESOURCE),
      contextFor(principalWith([])),
      { id: 'rq_1', formData: { deal_value: 800000, est_margin_pct: 18 } },
    )) as { formData: Record<string, unknown> };

    expect(result.formData.deal_value).toBe(800000);
    expect(result.formData).not.toHaveProperty('est_margin_pct');
  });

  it('masks inside form_data, where request payloads actually carry them', async () => {
    const result = (await run(
      interceptorFor(RESOURCE),
      contextFor(principalWith([])),
      { id: 'rq_1', form_data: { deal_value: 800000, est_margin_pct: 18 } },
    )) as { form_data: Record<string, unknown> };

    expect(result.form_data.deal_value).toBe(800000);
    expect(result.form_data).not.toHaveProperty('est_margin_pct');
  });

  it('masks every row of a §11.1 paginated envelope', async () => {
    const result = (await run(
      interceptorFor(RESOURCE),
      contextFor(principalWith([])),
      { data: [record, record], page: 1, page_size: 20, total: 2 },
    )) as { data: Record<string, unknown>[]; total: number };

    expect(result.total).toBe(2);
    expect(result.data.every((row) => !('est_margin_pct' in row))).toBe(true);
  });

  it('leaves responses alone when the handler declares no resource', async () => {
    const result = await run(
      interceptorFor(undefined),
      contextFor(principalWith([])),
      record,
    );

    expect(result).toEqual(record);
  });
});

describe('SCOPE-05 sensitive read audit', () => {
  it('records the read when a field is unmasked', async () => {
    const recordSensitiveRead = jest.fn().mockResolvedValue(undefined);

    await run(
      interceptorFor(RESOURCE, { recordSensitiveRead }),
      contextFor(principalWith([`${RESOURCE}.est_margin_pct`])),
      { id: 'rq_9001', est_margin_pct: 18 },
    );

    expect(recordSensitiveRead).toHaveBeenCalledWith(
      expect.objectContaining({ username: 'somchai.k' }),
      RESOURCE,
      'rq_9001',
      ['est_margin_pct'],
    );
  });

  it('records nothing when everything was masked', async () => {
    const recordSensitiveRead = jest.fn().mockResolvedValue(undefined);

    await run(
      interceptorFor(RESOURCE, { recordSensitiveRead }),
      contextFor(principalWith([])),
      { id: 'rq_9001', est_margin_pct: 18 },
    );

    expect(recordSensitiveRead).not.toHaveBeenCalled();
  });
});
