import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { isPermission } from '@request-management/share';

/**
 * กฎ scope ของ key (22 ต.ค. 2569): route ที่ทำในนามผู้ใช้ถามสิทธิ์ X ของคน
 * → key ต้องถือ `integration.X` — key กับคนตัดกันตรง ๆ ไม่มีตารางแปลงชื่อ.
 *
 * ข้อยกเว้นเดียว: route ที่ฝั่งคนแค่ต้อง login (`notification.read`, เหมือนหน้าจอ)
 * ใช้ scope ของ module เพราะ `integration.notification.read` จะเปิดทุก module.
 *
 * อ่าน source ทุก controller ของ external-service แบบเดียวกับ `crm-route-parity.spec.ts`.
 */
const LOGIN_ONLY: Readonly<Record<string, string>> = {
  pm: 'integration.pm.project.read',
  presales: 'integration.presales.solution.read',
  delivery: 'integration.delivery.read',
  support: 'integration.service.asset.read',
  assistant: 'integration.assistant.read',
};

const ROOT = join(__dirname, '..');

interface Handler {
  readonly where: string;
  readonly key?: string;
  readonly acting?: string;
}

function controllers(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return controllers(path);
    return name.endsWith('.controller.ts') ? [path] : [];
  });
}

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const first = (text: string, decorator: string) =>
  new RegExp(`@${decorator}\\('([\\w.]+)'`).exec(text)?.[1];

function handlersIn(file: string): Handler[] {
  const source = stripComments(readFileSync(file, 'utf8'));
  const at = source.indexOf('export class');
  const head = source.slice(0, at);
  const body = source.slice(at);
  const starts = [...body.matchAll(/@(Get|Post|Patch|Put|Delete)\(/g)].map(
    (match) => match.index,
  );

  return starts.map((start, i) => {
    // decorators sit just above and below the route one, inside this slice
    const from = body.lastIndexOf(')\n', start - 1);
    const block = body.slice(Math.max(from, 0), starts[i + 1] ?? body.length);
    const route = /@(?:Get|Post|Patch|Put|Delete)\(([^)]*)\)/.exec(
      block.slice(start - Math.max(from, 0)),
    );
    return {
      where: `${relative(ROOT, file)} ${route?.[0] ?? ''}`,
      key:
        first(block, 'Permissions') ??
        first(block, 'AnyPermission') ??
        first(head, 'Permissions'),
      acting:
        first(block, 'ActingPermissions') ?? first(head, 'ActingPermissions'),
    };
  });
}

describe('external-service: scope ของ key ตามสิทธิ์ผู้ใช้ของ route', () => {
  const handlers = controllers(ROOT).flatMap(handlersIn);

  it('reads the routes (guards the parser itself)', () => {
    expect(handlers.length).toBeGreaterThan(190);
    expect(handlers.filter((h) => h.acting).length).toBeGreaterThan(150);
  });

  it('asks the key for integration.<what it asks the person>', () => {
    const wrong = handlers
      .filter((h) => h.acting)
      .filter((h) => {
        const module = h.where.split('/')[0];
        const expected =
          h.acting === 'notification.read'
            ? LOGIN_ONLY[module]
            : `integration.${h.acting}`;
        return h.key !== expected;
      })
      .map((h) => `${h.where}: key=${h.key} acting=${h.acting}`);

    expect(wrong).toEqual([]);
  });

  it('every scope a route asks for is in the catalog', () => {
    const unknown = handlers
      .filter((h) => h.key?.startsWith('integration.'))
      .filter((h) => !isPermission(h.key))
      .map((h) => `${h.where}: ${h.key}`);

    expect(unknown).toEqual([]);
  });
});
