import { AppError } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { McpToolRegistry } from './mcp-tools';
import type { ToolContext } from './mcp-tools';

/**
 * ประตูที่สองของ MCP.
 *
 * REST ได้มาจาก `ActingPolicyGuard` แต่ MCP ใช้ guard นั้นไม่ได้ เพราะตัวตนของคน
 * ถูก resolve ต่อการเรียก tool ไม่ใช่ต่อ HTTP request ก่อนหน้านี้ MCP จึงมีประตู
 * เดียวและปล่อยให้ชั้นล่างตรวจเอาเอง — เทสต์ชุดนี้คือเหตุผลที่มันไม่เป็นแบบนั้นแล้ว
 */
function actor(permissions: readonly string[]): Principal {
  return {
    userId: 'user-acted-for',
    username: 'acted',
    activeCompanyId: 'company-osd',
    permissions,
    isServiceAccount: false,
    pendingOrgAssignment: false,
  } as unknown as Principal;
}

function registryWith(
  specs: readonly Record<string, unknown>[],
  handler: jest.Mock,
): McpToolRegistry {
  const registry = new McpToolRegistry({} as never);

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

  return registry;
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

    expect(() =>
      registry.call('tool_one', {}, contextOf(actor(['request.create']))),
    ).toThrow(AppError);
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
    const registry = new McpToolRegistry({} as never);
    Reflect.set(registry, 'handlers', { tool_one: jest.fn() });

    expect(() =>
      Reflect.get(registry, 'assertCatalogueMatches').call(registry, [
        { name: 'tool_one' },
      ]),
    ).toThrow(/x-acting-permission/);
  });
});
