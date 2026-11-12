import { AppError } from '../errors';
import {
  assertHumanPermissions,
  assertPermissionsFitLevel,
  assertServicePermissions,
} from './permission-types';

/** เรียก `run` แล้วคืน AppError ที่มันโยน — fail ทันทีถ้าไม่โยนหรือโยนคนละชนิด. */
function caught(run: () => void): AppError {
  try {
    run();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }

  throw new Error('ควรโยน AppError แต่ผ่านไปเฉย ๆ');
}

describe('AUTH-06 แยกสิทธิ์ของคนกับของเครื่อง', () => {
  describe('assertHumanPermissions', () => {
    it('ชุดสิทธิ์ของคนล้วนผ่าน', () => {
      expect(() =>
        assertHumanPermissions([
          'request.read',
          'crm.customer.manage',
          'admin.role.manage',
        ]),
      ).not.toThrow();
    });

    it('role ของคนถือ integration.* ไม่ได้', () => {
      expect(() =>
        assertHumanPermissions(['request.read', 'integration.crm.lead.create']),
      ).toThrow(AppError);
    });

    it('บอกทุกตัวที่ขัด ไม่ใช่ตัวแรกตัวเดียว', () => {
      const thrown = caught(() =>
        assertHumanPermissions([
          'integration.request.create',
          'request.read',
          'integration.crm.sales.read',
        ]),
      );

      expect(thrown.details.map((detail) => detail.reason)).toEqual([
        'integration.request.create',
        'integration.crm.sales.read',
      ]);
    });

    it('ชุดว่างผ่าน — role ที่ยังไม่ติ๊กอะไรเลยไม่ใช่ความผิด', () => {
      expect(() => assertHumanPermissions([])).not.toThrow();
    });
  });

  describe('assertServicePermissions', () => {
    it('ชุด integration.* ล้วนผ่าน', () => {
      expect(() =>
        assertServicePermissions([
          'integration.crm.customer.read',
          'integration.request.create',
        ]),
      ).not.toThrow();
    });

    it('กุญแจถือสิทธิ์ของคนไม่ได้', () => {
      expect(() =>
        assertServicePermissions([
          'integration.crm.customer.read',
          'admin.role.manage',
        ]),
      ).toThrow(AppError);
    });

    it('ฟิลด์ที่รายงานคือ scopes ไม่ใช่ permissions', () => {
      expect(
        caught(() => assertServicePermissions(['approval.decide'])).details[0]
          .field,
      ).toBe('scopes');
    });
  });

  it('รหัสที่ไม่มีใน catalog ไม่ถูกตัดสินที่นี่', () => {
    expect(() =>
      assertHumanPermissions(['ไม่มีจริง.อะไรสักอย่าง']),
    ).not.toThrow();
    expect(() =>
      assertServicePermissions(['ไม่มีจริง.อะไรสักอย่าง']),
    ).not.toThrow();
  });
});

describe('P5 — role ระดับไหนถือสิทธิ์ระดับนั้น', () => {
  it('role ระบบถือได้แค่ system.*', () => {
    expect(() =>
      assertPermissionsFitLevel('SYSTEM', ['system.user.read']),
    ).not.toThrow();
    const error = caught(() =>
      assertPermissionsFitLevel('SYSTEM', ['system.user.read', 'user.read']),
    );
    expect(error.code).toBe('UNPROCESSABLE');
    expect(error.details).toEqual([
      { field: 'permissions', reason: 'user.read' },
    ]);
  });

  it('role บริษัทถือ system.* ไม่ได้', () => {
    expect(() =>
      assertPermissionsFitLevel('COMPANY', ['user.read']),
    ).not.toThrow();
    expect(
      caught(() =>
        assertPermissionsFitLevel('COMPANY', [
          'user.read',
          'system.tenant.read',
        ]),
      ).details,
    ).toEqual([{ field: 'permissions', reason: 'system.tenant.read' }]);
  });
});
