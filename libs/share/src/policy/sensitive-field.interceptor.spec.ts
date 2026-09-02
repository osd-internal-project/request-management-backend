import { of, lastValueFrom } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import {
  SENSITIVE_RESOURCE_KEY,
  SensitiveFieldInterceptor,
} from './sensitive-field.interceptor';
import type { Principal } from '../context/principal';

const RESOURCE = 'request:DSC';

/** Only the fields the interceptor reads. */
function principal(visible: string[]): Principal {
  return {
    userId: 'user-1',
    activeCompanyId: 'company-osd',
    sensitiveFieldsAll: [`${RESOURCE}.margin`, `${RESOURCE}.unit_price`],
    sensitiveFieldsVisible: visible.map((field) => `${RESOURCE}.${field}`),
  } as unknown as Principal;
}

/** Runs one response body through the interceptor as `who` would see it. */
async function through(body: unknown, who: Principal): Promise<unknown> {
  const recorded: { fields: string[] }[] = [];

  const interceptor = new SensitiveFieldInterceptor(
    {
      getAllAndOverride: (key: string) =>
        key === SENSITIVE_RESOURCE_KEY ? RESOURCE : undefined,
    } as unknown as Reflector,
    {
      recordSensitiveRead: (
        _actor: Principal,
        _resource: string,
        _id: string,
        fields: string[],
      ) => {
        recorded.push({ fields });
        return Promise.resolve();
      },
    },
  );

  const context = {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => ({ principal: who }) }),
  } as unknown as ExecutionContext;

  const next: CallHandler = { handle: () => of(body) };

  const result = await lastValueFrom(interceptor.intercept(context, next));

  return { result, recorded };
}

/**
 * SCOPE-04 — *"ผู้ไม่มีสิทธิ์เห็นค่าถูกปกปิด ทั้งใน API response ไม่ใช่แค่หน้าจอ"*.
 *
 * A table field (`type: 'array'`) holds its answers as rows, so a sensitive
 * column lives one level below the container the masking already walked:
 * `form_data.lines[0].unit_price`, never `form_data.unit_price`. Declaring
 * that column sensitive looked handled and shipped every row.
 */
describe('SCOPE-04 masking reaches inside table rows', () => {
  const body = {
    id: 'req-1',
    form_data: {
      customer_name: 'บจก. ตัวอย่าง',
      margin: 18,
      lines: [
        { item_name: 'ป้ายไวนิล', qty: 2, unit_price: 1500 },
        { item_name: 'โปสเตอร์', qty: 10, unit_price: 90 },
      ],
    },
  };

  it('removes a sensitive column from every row', async () => {
    const { result } = (await through(body, principal([]))) as {
      result: { form_data: { lines: Record<string, unknown>[] } };
    };

    for (const row of result.form_data.lines) {
      expect(row).not.toHaveProperty('unit_price');
      // The rest of the row survives — masking a column is not dropping a row.
      expect(row).toHaveProperty('item_name');
      expect(row).toHaveProperty('qty');
    }
  });

  it('still removes the plain container-level field', async () => {
    const { result } = (await through(body, principal([]))) as {
      result: { form_data: Record<string, unknown> };
    };

    expect(result.form_data).not.toHaveProperty('margin');
    expect(result.form_data).toHaveProperty('customer_name');
  });

  it('leaves the rows intact for somebody who may see the column', async () => {
    const { result } = (await through(
      body,
      principal(['unit_price', 'margin']),
    )) as { result: { form_data: { lines: Record<string, unknown>[] } } };

    expect(result.form_data.lines[0].unit_price).toBe(1500);
    expect(result.form_data.lines[1].unit_price).toBe(90);
  });

  /**
   * SCOPE-05. Without this the audit says nobody looked at a value that was
   * handed over in full — the read is only recorded when the field is visible.
   */
  it('records the read when a sensitive column was returned unmasked', async () => {
    const { recorded } = (await through(body, principal(['unit_price']))) as {
      recorded: { fields: string[] }[];
    };

    expect(recorded).toHaveLength(1);
    expect(recorded[0].fields).toContain('unit_price');
  });

  it('does not mistake a row for a container it should mask', async () => {
    const plain = { id: 'req-2', form_data: { lines: ['a', 'b'], margin: 5 } };

    const { result } = (await through(plain, principal([]))) as {
      result: { form_data: { lines: unknown[] } };
    };

    // A list of strings is not a table; it passes through untouched.
    expect(result.form_data.lines).toEqual(['a', 'b']);
  });
});
