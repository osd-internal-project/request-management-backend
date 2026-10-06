import { AppError, SensitiveFieldMasker } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { SourceLinks } from '../common/source-links';
import { McpToolRegistry } from './mcp-tools';
import type { ToolContext } from './mcp-tools';

/**
 * ประตูที่สองของ MCP.
 *
 * REST ได้มาจาก `ActingPolicyGuard` แต่ MCP ใช้ guard นั้นไม่ได้ เพราะตัวตนของคน
 * ถูก resolve ต่อการเรียก tool ไม่ใช่ต่อ HTTP request ก่อนหน้านี้ MCP จึงมีประตู
 * เดียวและปล่อยให้ชั้นล่างตรวจเอาเอง — เทสต์ชุดนี้คือเหตุผลที่มันไม่เป็นแบบนั้นแล้ว
 */
function actor(
  permissions: readonly string[],
  sensitive: { all?: string[]; visible?: string[] } = {},
): Principal {
  return {
    userId: 'user-acted-for',
    username: 'acted',
    activeCompanyId: 'company-osd',
    permissions,
    isServiceAccount: false,
    pendingOrgAssignment: false,
    sensitiveFieldsAll: sensitive.all ?? [],
    sensitiveFieldsVisible: sensitive.visible ?? [],
  } as unknown as Principal;
}

/** ตัว registry ที่ประกอบมือ — constructor ตัวจริงขอ service ที่เทสต์นี้ไม่ใช้เลย. */
function bareRegistry(): McpToolRegistry {
  return new McpToolRegistry(
    {} as never,
    new SensitiveFieldMasker(),
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    new SourceLinks({ get: () => 'https://ctd.test' } as never),
  );
}

function registryWith(
  specs: readonly Record<string, unknown>[],
  handler: jest.Mock,
): McpToolRegistry {
  const registry = bareRegistry();

  Reflect.set(registry, 'handlers', { tool_one: handler });
  Reflect.set(
    registry,
    'actingPermissions',
    new Map(
      specs.map((spec) => [
        spec.name as string,
        (spec['x-acting-permission'] as string[] | undefined) ?? [],
      ]),
    ),
  );
  Reflect.set(
    registry,
    'sensitiveResources',
    new Map(
      specs.map((spec) => [
        spec.name as string,
        (spec['x-sensitive-resource'] as string | undefined) ?? '',
      ]),
    ),
  );

  return registry;
}

/** `assertCatalogueMatches` เป็น private — เรียกตรงนี้โดยไม่ผ่าน `any`. */
function assertCatalogue(
  registry: McpToolRegistry,
  specs: readonly Record<string, unknown>[],
): void {
  (
    registry as unknown as {
      assertCatalogueMatches(specs: readonly Record<string, unknown>[]): void;
    }
  ).assertCatalogueMatches(specs);
}

function contextOf(principal: Principal): ToolContext {
  return { actor: principal, authorization: 'Bearer x' };
}

describe('McpToolRegistry — ประตูที่สอง', () => {
  const SPECS = [{ name: 'tool_one', 'x-acting-permission': ['request.read'] }];

  it('คนที่มีสิทธิ์เรียก tool ได้', async () => {
    const handler = jest.fn().mockResolvedValue({ ok: true });
    const registry = registryWith(SPECS, handler);

    await expect(
      registry.call('tool_one', {}, contextOf(actor(['request.read']))),
    ).resolves.toEqual({ ok: true });
    expect(handler).toHaveBeenCalled();
  });

  it('คนที่ไม่มีสิทธิ์ถูกปฏิเสธ และ handler ไม่ถูกเรียกเลย', async () => {
    const handler = jest.fn();
    const registry = registryWith(SPECS, handler);

    await expect(
      registry.call('tool_one', {}, contextOf(actor(['request.create']))),
    ).rejects.toThrow(AppError);
    expect(handler).not.toHaveBeenCalled();
  });

  it('tool ที่ตรวจสิทธิ์ข้างในเอง (x-acting-permission ว่าง) ผ่านประตูนี้ไปได้', async () => {
    const handler = jest.fn().mockResolvedValue({ ok: true });
    const registry = registryWith(
      [{ name: 'tool_one', 'x-acting-permission': [] }],
      handler,
    );

    await expect(
      registry.call('tool_one', {}, contextOf(actor([]))),
    ).resolves.toEqual({ ok: true });
  });

  it('catalogue รุ่นเก่าที่ไม่มี x-acting-permission ทำให้ boot ไม่ผ่าน', () => {
    const registry = bareRegistry();
    Reflect.set(registry, 'handlers', { tool_one: jest.fn() });

    expect(() => assertCatalogue(registry, [{ name: 'tool_one' }])).toThrow(
      /x-acting-permission/,
    );
  });

  it('catalogue ที่ไม่ประกาศ x-sensitive-resource ทำให้ boot ไม่ผ่าน', () => {
    const registry = bareRegistry();
    Reflect.set(registry, 'handlers', { tool_one: jest.fn() });

    expect(() =>
      assertCatalogue(registry, [
        { name: 'tool_one', 'x-acting-permission': [] },
      ]),
    ).toThrow(/x-sensitive-resource/);
  });
});

/**
 * SCOPE-04 ที่ประตูที่ไม่ใช่ HTTP.
 *
 * ฝั่ง REST การปกปิดมาจาก `SensitiveFieldInterceptor` ที่อ่าน `@SensitiveResource`
 * จาก handler — MCP เรียก service ตรง ๆ interceptor จึงไม่เคยทำงาน ถ้า `call` ไม่
 * ปกปิดเอง tool ของ CRM จะตอบเลขผู้เสียภาษีและ margin ให้ทุกคนที่เรียกได้
 * โดยหน้าจอเดียวกันยังปกปิดอยู่ — เทสต์ชุดนี้คือสิ่งที่กันไม่ให้กลับไปเป็นแบบนั้น
 */
describe('McpToolRegistry — การปกปิดฟิลด์อ่อนไหว', () => {
  const SPECS = [
    {
      name: 'tool_one',
      'x-acting-permission': ['crm.customer.read'],
      'x-sensitive-resource': 'customer',
    },
  ];

  const CUSTOMER = { id: 'c-1', name: 'บจก. ตัวอย่าง', taxId: '0105500000001' };

  it('คนที่ไม่มีสิทธิ์อ่านข้อมูลอ่อนไหวไม่เห็นเลขผู้เสียภาษี', async () => {
    const registry = registryWith(
      SPECS,
      jest.fn().mockResolvedValue({ ...CUSTOMER }),
    );

    const answer = await registry.call(
      'tool_one',
      {},
      contextOf(
        actor(['crm.customer.read'], { all: ['customer.taxId'], visible: [] }),
      ),
    );

    // ลบทิ้ง ไม่ใช่ทำเป็น null — ผู้เรียกแยกไม่ออกว่า "ไม่ให้ดู" กับ "ไม่มีค่า"
    expect(answer).toEqual({ id: 'c-1', name: 'บจก. ตัวอย่าง' });
  });

  it('คนที่มีสิทธิ์ยังเห็นค่าเดิม', async () => {
    const registry = registryWith(
      SPECS,
      jest.fn().mockResolvedValue({ ...CUSTOMER }),
    );

    const answer = await registry.call(
      'tool_one',
      {},
      contextOf(
        actor(['crm.customer.read'], {
          all: ['customer.taxId'],
          visible: ['customer.taxId'],
        }),
      ),
    );

    expect(answer).toEqual(CUSTOMER);
  });

  it('ปกปิดทุกแถวของ envelope แบบแบ่งหน้า ไม่ใช่แค่ระดับบนสุด', async () => {
    const registry = registryWith(
      SPECS,
      jest.fn().mockResolvedValue({ data: [{ ...CUSTOMER }], total: 1 }),
    );

    const answer = (await registry.call(
      'tool_one',
      {},
      contextOf(
        actor(['crm.customer.read'], { all: ['customer.taxId'], visible: [] }),
      ),
    )) as { data: unknown[]; total: number };

    expect(answer.total).toBe(1);
    expect(answer.data).toEqual([{ id: 'c-1', name: 'บจก. ตัวอย่าง' }]);
  });

  it('tool ที่ไม่ประกาศชุดกฎปกปิด คืนค่าเดิมทั้งก้อน', async () => {
    const registry = registryWith(
      [{ name: 'tool_one', 'x-acting-permission': [] }],
      jest.fn().mockResolvedValue({ ...CUSTOMER }),
    );

    await expect(
      registry.call(
        'tool_one',
        {},
        contextOf(actor([], { all: ['customer.taxId'], visible: [] })),
      ),
    ).resolves.toEqual(CUSTOMER);
  });
});
