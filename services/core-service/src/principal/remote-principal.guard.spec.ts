import { Reflector } from '@nestjs/core';
import {
  AppError,
  getPrincipal,
  COMPANY_HEADER,
} from '@request-management/share';
import type {
  Principal,
  RequestWithPrincipal,
} from '@request-management/share';
import { getApiKey } from './api-key.service';
import { RemotePrincipalGuard } from './remote-principal.guard';

/**
 * AUTH-06, 14 ก.ย. 2569 — สิ่งที่กุญแจตัดสินแทนผู้เรียก.
 *
 * ช่องทางรับ Lead ยิงเข้ามาด้วย "API key อย่างเดียว" ได้ก็เพราะ guard ตัวนี้อ่าน
 * บริษัทกับสิทธิ์ออกจากตัวกุญแจ. สามข้อที่ test ไว้คือสามข้อที่พังแล้วเงียบ:
 * เขียนผิดบริษัท, กุญแจที่หลุดทำได้เกินหน้าที่, และ key เดิมที่ต้องไม่เปลี่ยน
 * พฤติกรรม.
 */
describe('RemotePrincipalGuard — API key ตัดสินบริษัทและสิทธิ์', () => {
  const PRINCIPAL = {
    userId: 'svc',
    activeCompanyId: 'osd',
    isServiceAccount: true,
    permissions: [
      'integration.crm.lead.create',
      'integration.request.create',
      'request.read',
    ],
  } as unknown as Principal;

  function contextFor(request: RequestWithPrincipal) {
    return {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => request }),
    } as never;
  }

  function guardWith(
    key: Record<string, unknown> | null,
    principal: Principal = PRINCIPAL,
  ) {
    const resolve = jest.fn().mockResolvedValue(principal);
    const principals = { resolve } as never;
    const apiKeys = {
      resolve: jest
        .fn()
        .mockResolvedValue(
          key === null ? null : { accessToken: 'minted', key },
        ),
    } as never;

    const reflector = {
      getAllAndOverride: () => false,
    } as unknown as Reflector;

    return {
      guard: new RemotePrincipalGuard(reflector, principals, apiKeys),
      resolve,
    };
  }

  const channelKey = {
    id: 'key-1',
    prefix: 'rfk_abcdefgh',
    name: 'เว็บไซต์ osd.co.th',
    companyId: 'osd',
    sourceCode: 'website',
    scopes: ['integration.crm.lead.create'],
  };

  function request(headers: Record<string, string>) {
    return {
      headers: { authorization: 'Bearer rfk_x', ...headers },
    } as never as RequestWithPrincipal;
  }

  it('กุญแจที่ผูกบริษัทไว้ = ผู้เรียกไม่ต้องส่ง X-Company-Id', async () => {
    const { guard, resolve } = guardWith(channelKey);
    const call = request({});

    await guard.canActivate(contextFor(call));

    expect(resolve).toHaveBeenCalledWith('Bearer minted', 'osd');
    // เขียนกลับลง header ด้วย ไม่งั้น CompanyGuard ที่รันถัดไปจะไม่เห็นบริษัท
    expect(call.headers[COMPANY_HEADER]).toBe('osd');
  });

  it('ส่ง X-Company-Id ที่ขัดกับกุญแจ = ปฏิเสธ ไม่ใช่เขียนลงบริษัทอื่นเงียบ ๆ', async () => {
    const { guard } = guardWith(channelKey);

    await expect(
      guard.canActivate(contextFor(request({ [COMPANY_HEADER]: 'other-co' }))),
    ).rejects.toMatchObject({ code: 'COMPANY_FORBIDDEN' });
  });

  it('scopes คือสิทธิ์ — กุญแจเว็บฟอร์มเปิดได้แค่ Lead', async () => {
    const { guard } = guardWith(channelKey);
    const call = request({});

    await guard.canActivate(contextFor(call));

    expect(getPrincipal(call)?.permissions).toEqual([
      'integration.crm.lead.create',
    ]);
  });

  it('scopes ที่ token ไม่ได้ให้มา ก็ยังใช้ได้ — token พิสูจน์ตัวตน ไม่ได้ให้สิทธิ์', async () => {
    // `integration.crm.customer.read` ไม่อยู่ใน PRINCIPAL.permissions กฎเดิมจึงตัดทิ้ง
    // กฎใหม่ให้ผ่าน — นี่คือเคสจริงที่เคยตอบ FORBIDDEN ทั้งที่กุญแจถือสิทธิ์อยู่
    const { guard } = guardWith({
      ...channelKey,
      scopes: ['integration.crm.customer.read'],
    });
    const call = request({});

    await guard.canActivate(contextFor(call));

    expect(getPrincipal(call)?.permissions).toEqual([
      'integration.crm.customer.read',
    ]);
  });

  it('รหัสที่ไม่มีใน catalog บนกุญแจเก่า ถูกทิ้ง ไม่ใช่ส่งต่อ', async () => {
    const { guard } = guardWith({
      ...channelKey,
      scopes: ['integration.crm.lead.create', 'integration.ที่ถูกถอดไปแล้ว'],
    });
    const call = request({});

    await guard.canActivate(contextFor(call));

    expect(getPrincipal(call)?.permissions).toEqual([
      'integration.crm.lead.create',
    ]);
  });

  it('key ที่ scopes ว่าง = ไม่มีสิทธิ์เลย ไม่ใช่สิทธิ์เต็มของบัญชีบริการ', async () => {
    const { guard, resolve } = guardWith({
      ...channelKey,
      companyId: null,
      sourceCode: null,
      scopes: [],
    });
    const call = request({ [COMPANY_HEADER]: 'osd-demo' });

    await guard.canActivate(contextFor(call));

    expect(resolve).toHaveBeenCalledWith('Bearer minted', 'osd-demo');
    expect(getPrincipal(call)?.permissions).toEqual([]);
  });

  it('บัญชีบริการที่ยิงมาโดยไม่มีกุญแจ ถูกปฏิเสธ', async () => {
    const { guard } = guardWith(null);

    await expect(
      guard.canActivate(
        contextFor(request({ authorization: 'Bearer eyJhbGciOi.jwt' })),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('กุญแจถูกแนบไว้กับ request ให้ handler อ่านช่องทางได้', async () => {
    const { guard } = guardWith(channelKey);
    const call = request({});

    await guard.canActivate(contextFor(call));

    expect(getApiKey(call)?.sourceCode).toBe('website');
  });

  it('token ของคนธรรมดา (ไม่ใช่ key) ไม่ถูกแตะต้อง', async () => {
    const { guard, resolve } = guardWith(null, {
      ...PRINCIPAL,
      isServiceAccount: false,
    });
    const call = request({ authorization: 'Bearer eyJhbGciOi.jwt' });

    await guard.canActivate(contextFor(call));

    expect(resolve).toHaveBeenCalledWith('Bearer eyJhbGciOi.jwt', undefined);
    expect(getApiKey(call)).toBeUndefined();
    expect(getPrincipal(call)?.permissions).toEqual(PRINCIPAL.permissions);
  });

  it('ไม่มี Authorization = 401 ก่อนจะไปแตะอะไร', async () => {
    const { guard } = guardWith(channelKey);

    await expect(
      guard.canActivate(contextFor({ headers: {} } as never)),
    ).rejects.toBeInstanceOf(AppError);
  });
});
