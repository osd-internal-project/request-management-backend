import { createHash } from 'node:crypto';
import type { Principal } from '@request-management/share';
import { ApiKeyAdminService } from './api-key-admin.service';
import { API_KEY_PREFIX } from './api-key.service';

/**
 * AUTH-06, 14 ก.ย. 2569 — ออกกุญแจจากหน้าจอได้ โดยไม่ทิ้งสำเนาไว้ที่ไหน.
 *
 * สิ่งที่ test ไว้คือข้อแลกเปลี่ยนที่ยอมให้ย้ายจาก CLI มาอยู่บนหน้าจอ: ค่าเต็ม
 * ออกครั้งเดียว, ฐานข้อมูลเก็บแค่ hash, audit ไม่เคยเห็นตัวกุญแจ, และกุญแจผูก
 * กับบริษัทของคนออกเสมอ.
 */
describe('ApiKeyAdminService — ออกกุญแจช่องทางจากหน้าจอผู้ดูแล', () => {
  function admin(companyId = 'osd'): Principal {
    return {
      userId: 'admin-1',
      displayName: 'ผู้ดูแล ระบบ',
      activeCompanyId: companyId,
      permissions: ['admin.integration.manage'],
    } as unknown as Principal;
  }

  function harness(rows: Record<string, unknown>[] = []) {
    const audits: { eventType: string; after?: unknown; before?: unknown }[] =
      [];
    const created: Record<string, unknown>[] = [];

    const row = (data: Record<string, unknown>) => ({
      id: 'key-1',
      active: true,
      revokedAt: null,
      lastUsedAt: null,
      createdAt: new Date('2026-09-14T09:00:00.000Z'),
      expiresAt: null,
      scopes: [],
      sourceCode: null,
      ...data,
    });

    const keys = {
      findMany: jest.fn((_args: { where: Record<string, unknown> }) =>
        Promise.resolve(rows),
      ),
      findFirst: jest.fn((_args: { where: Record<string, unknown> }) =>
        Promise.resolve(rows[0] ?? null),
      ),
      create: jest.fn((args: { data: Record<string, unknown> }) => {
        created.push(args.data);
        return Promise.resolve(row(args.data));
      }),
      update: jest.fn((args: { data: Record<string, unknown> }) =>
        Promise.resolve(row({ ...rows[0], ...args.data })),
      ),
    };

    const audit = {
      record: jest.fn((entry: { eventType: string }) => {
        audits.push(entry);
        return Promise.resolve();
      }),
    };

    return {
      service: new ApiKeyAdminService(keys as never, audit as never),
      keys,
      created,
      audits,
    };
  }

  const request = {
    name: 'เว็บไซต์ osd.co.th',
    source_code: 'website',
    scopes: ['integration.crm.lead.create'],
  };

  it('คืนค่าเต็มของกุญแจครั้งเดียว และเก็บลงฐานข้อมูลแค่ sha256', async () => {
    const { service, created } = harness();

    const issued = await service.issue(request, admin());

    expect(issued.key.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(issued.prefix).toBe(issued.key.slice(0, 12));
    expect(created[0].keyHash).toBe(
      createHash('sha256').update(issued.key).digest('hex'),
    );
    // ค่าเต็มต้องไม่ถูกเก็บไว้ในคอลัมน์ไหนเลย
    expect(JSON.stringify(created[0])).not.toContain(issued.key);
  });

  it('ผูกกับบริษัทที่ผู้ออกกำลังทำงานอยู่ ไม่ใช่ค่าที่ส่งมาใน body', async () => {
    const { service, created } = harness();

    await service.issue(
      { ...request, company_id: 'other-co' } as never,
      admin('osd-demo'),
    );

    expect(created[0].companyId).toBe('osd-demo');
  });

  it('audit บันทึกว่าใครออกให้ช่องทางไหน แต่ไม่เคยบันทึกตัวกุญแจ', async () => {
    const { service, audits } = harness();

    const issued = await service.issue(request, admin());

    expect(audits[0].eventType).toBe('admin.api_key.issued');
    expect(audits[0].after).toMatchObject({
      prefix: issued.prefix,
      sourceCode: 'website',
      scopes: ['integration.crm.lead.create'],
    });
    expect(JSON.stringify(audits[0])).not.toContain(issued.key);
  });

  it('ติ๊กสิทธิ์นอก integration.* ไม่ได้ — หน้าจอนี้ออกกุญแจของแอดมินไม่ได้', async () => {
    const { service, keys } = harness();

    await expect(
      service.issue(
        { ...request, scopes: ['admin.role.manage', 'crm.sales.manage'] },
        admin(),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(keys.create).not.toHaveBeenCalled();
  });

  it('สิทธิ์ซ้ำถูกยุบเหลือใบละครั้ง', async () => {
    const { service, created } = harness();

    await service.issue(
      {
        ...request,
        scopes: ['integration.crm.lead.create', 'integration.crm.lead.create'],
      },
      admin(),
    );

    expect(created[0].scopes).toEqual(['integration.crm.lead.create']);
  });

  it('รายการเห็นเฉพาะกุญแจของบริษัทตัวเอง และไม่มี hash ติดออกไป', async () => {
    const { service, keys } = harness([
      {
        id: 'key-1',
        prefix: 'rfk_aaaaaaaa',
        name: 'เว็บไซต์',
        keyHash: 'do-not-leak-me',
        sourceCode: 'website',
        scopes: ['integration.crm.lead.create'],
        active: true,
        expiresAt: null,
        revokedAt: null,
        lastUsedAt: null,
        createdAt: new Date('2026-09-14T09:00:00.000Z'),
        createdBy: 'admin-1',
      },
    ]);

    const rows = await service.list(admin());

    expect(keys.findMany.mock.calls[0][0]).toMatchObject({
      where: { companyId: 'osd' },
    });
    expect(rows[0].status).toBe('active');
    expect(JSON.stringify(rows)).not.toContain('do-not-leak-me');
  });

  it.each([
    ['หมดอายุแล้ว', { expiresAt: new Date('2026-09-01') }, 'expired'],
    ['เพิกถอนแล้ว', { revokedAt: new Date('2026-09-01') }, 'revoked'],
  ])(
    'สถานะ %s คำนวณจากแถว ไม่ใช่คอลัมน์ที่ต้องคอยอัปเดต',
    async (_case, patch, expected) => {
      const { service } = harness([
        {
          id: 'key-1',
          prefix: 'rfk_aaaaaaaa',
          name: 'เว็บไซต์',
          sourceCode: 'website',
          scopes: [],
          active: true,
          expiresAt: null,
          revokedAt: null,
          lastUsedAt: null,
          createdAt: new Date('2026-09-14T09:00:00.000Z'),
          createdBy: 'admin-1',
          ...patch,
        },
      ]);

      const rows = await service.list(admin());

      expect(rows[0].status).toBe(expected);
    },
  );

  it('เพิกถอนแล้วเขียน audit และปิด active', async () => {
    const { service, keys, audits } = harness([
      {
        id: 'key-1',
        prefix: 'rfk_aaaaaaaa',
        name: 'เว็บไซต์',
        sourceCode: 'website',
        scopes: [],
        active: true,
        expiresAt: null,
        revokedAt: null,
        lastUsedAt: null,
        createdAt: new Date('2026-09-14T09:00:00.000Z'),
        createdBy: 'admin-1',
      },
    ]);

    await service.revoke('key-1', admin());

    expect(keys.update.mock.calls[0][0].data).toMatchObject({
      active: false,
      revokedBy: 'admin-1',
    });
    expect(audits.map((entry) => entry.eventType)).toContain(
      'admin.api_key.revoked',
    );
  });

  it('เพิกถอนซ้ำ = ไม่เขียนอะไรเพิ่ม', async () => {
    const { service, keys, audits } = harness([
      {
        id: 'key-1',
        prefix: 'rfk_aaaaaaaa',
        name: 'เว็บไซต์',
        sourceCode: 'website',
        scopes: [],
        active: false,
        expiresAt: null,
        revokedAt: new Date('2026-09-10'),
        lastUsedAt: null,
        createdAt: new Date('2026-09-14T09:00:00.000Z'),
        createdBy: 'admin-1',
      },
    ]);

    await service.revoke('key-1', admin());

    expect(keys.update).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
  });

  describe('แก้สิทธิ์ของกุญแจที่ออกไปแล้ว', () => {
    const live = (overrides: Record<string, unknown> = {}) => [
      {
        id: 'key-1',
        prefix: 'rfk_aaaaaaaa',
        name: 'เว็บไซต์',
        sourceCode: 'website',
        scopes: ['integration.crm.lead.create'],
        active: true,
        expiresAt: null,
        revokedAt: null,
        lastUsedAt: null,
        createdAt: new Date('2026-09-14T09:00:00.000Z'),
        createdBy: 'admin-1',
        ...overrides,
      },
    ];

    it('แทนที่ทั้งชุด ไม่ใช่เพิ่มเข้าไป — เอาสิทธิ์ออกได้ด้วย', async () => {
      const { service, keys } = harness(live());

      await service.updateScopes(
        'key-1',
        { scopes: ['integration.crm.lead.read'] },
        admin(),
      );

      expect(keys.update.mock.calls[0][0].data).toEqual({
        scopes: ['integration.crm.lead.read'],
      });
    });

    it('audit เก็บทั้งชุดเดิมและชุดใหม่ ไม่ใช่แค่ผลลัพธ์', async () => {
      const { service, audits } = harness(live());

      await service.updateScopes(
        'key-1',
        { scopes: ['integration.crm.lead.read'] },
        admin(),
      );

      expect(audits[0]).toMatchObject({
        eventType: 'admin.api_key.scopes_changed',
        before: { scopes: ['integration.crm.lead.create'] },
        after: { scopes: ['integration.crm.lead.read'] },
      });
    });

    it('ติ๊กสิทธิ์นอก integration.* ไม่ได้ เหมือนตอนออกใบใหม่', async () => {
      const { service, keys } = harness(live());

      await expect(
        service.updateScopes(
          'key-1',
          { scopes: ['admin.role.manage'] },
          admin(),
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(keys.update).not.toHaveBeenCalled();
    });

    it('สิทธิ์ซ้ำถูกยุบ เหมือนตอนออกใบใหม่', async () => {
      const { service, keys } = harness(live());

      await service.updateScopes(
        'key-1',
        {
          scopes: ['integration.crm.lead.read', 'integration.crm.lead.read'],
        },
        admin(),
      );

      expect(keys.update.mock.calls[0][0].data.scopes).toEqual([
        'integration.crm.lead.read',
      ]);
    });

    it('กุญแจที่เพิกถอนแล้วแก้ไม่ได้ — หน้าจอต้องไม่ดูเหมือนคืนชีพให้มันได้', async () => {
      const { service, keys } = harness(
        live({ active: false, revokedAt: new Date('2026-09-10') }),
      );

      await expect(
        service.updateScopes(
          'key-1',
          { scopes: ['integration.crm.lead.read'] },
          admin(),
        ),
      ).rejects.toMatchObject({ code: 'UNPROCESSABLE' });
      expect(keys.update).not.toHaveBeenCalled();
    });

    it('SCOPE-03: แก้กุญแจของบริษัทอื่น = 404', async () => {
      const { service } = harness([]);

      await expect(
        service.updateScopes(
          'key-x',
          { scopes: ['integration.crm.lead.read'] },
          admin(),
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  it('SCOPE-03: กุญแจของบริษัทอื่น = 404 ไม่ใช่ 403', async () => {
    const { service } = harness([]);

    await expect(service.revoke('key-x', admin())).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('ตัวเลือกสิทธิ์มาจาก catalog — integration.* ทั้งหมด ไม่มีตัวอื่นปน', () => {
    const { service } = harness();

    const codes = service.scopes().map((scope) => scope.code);

    expect(codes).toContain('integration.crm.lead.create');
    expect(codes.every((code) => code.startsWith('integration.'))).toBe(true);
  });
});
