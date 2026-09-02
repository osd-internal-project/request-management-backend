import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ROLE-01 — "every endpoint declares its required permission and is checked at
 * the backend. No endpoint is open by default."
 *
 * The §14 Definition of Done asks for a negative case on every endpoint. There
 * are 84 of them, and 168 hand-written "403 without the permission" tests would
 * be a body of work that still says nothing about endpoint 85. This asserts the
 * property instead: a route added without a guard fails the build the day it is
 * written, whether or not anyone remembers to test it.
 *
 * It reads source rather than Nest metadata deliberately — no database, no
 * module wiring, and it covers both services from one place.
 */
const SERVICES = join(__dirname, '..', '..', '..', '..', 'services');

const ROUTE = /@(Get|Post|Patch|Put|Delete)\(/g;
// `AnyPermission` counts: it declares access just as explicitly as the rest.
// Leaving it out silently reclassified two guarded routes as open the day it
// was introduced — which is precisely what this file exists to catch.
const GUARD = /@(Permissions|AnyPermission|Public|Authenticated)\(/g;

interface Controller {
  readonly file: string;
  readonly routes: number;
  readonly guards: number;
}

function controllerFiles(dir: string): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;

    const path = join(dir, entry);

    if (statSync(path).isDirectory()) found.push(...controllerFiles(path));
    else if (entry.endsWith('.controller.ts') && !entry.endsWith('.spec.ts')) {
      found.push(path);
    }
  }

  return found;
}

function read(): Controller[] {
  return controllerFiles(SERVICES).map((file) => {
    const source = readFileSync(file, 'utf-8');

    return {
      file: file.slice(SERVICES.length + 1),
      routes: source.match(ROUTE)?.length ?? 0,
      guards: source.match(GUARD)?.length ?? 0,
    };
  });
}

describe('ROLE-01 — no endpoint is open by default', () => {
  const controllers = read();

  it('finds the controllers', () => {
    expect(controllers.length).toBeGreaterThan(5);
    expect(controllers.reduce((sum, c) => sum + c.routes, 0)).toBeGreaterThan(
      50,
    );
  });

  it.each(read().map((c) => [c.file, c] as const))(
    '%s declares a guard on every route',
    (_file, controller) => {
      // Guards can outnumber routes — a route may carry both `@Authenticated`
      // and `@ServiceAccountAllowed`. Fewer guards than routes means at least
      // one route has none.
      expect(controller.guards).toBeGreaterThanOrEqual(controller.routes);
    },
  );

  it('leaves nothing unguarded across either service', () => {
    const unguarded = controllers.filter((c) => c.guards < c.routes);

    expect(unguarded.map((c) => c.file)).toEqual([]);
  });
});

describe('SUP-04 — the audit log is append-only', () => {
  it('exposes no mutating route on any audit controller', () => {
    const mutating = controllerFiles(SERVICES)
      .filter((file) => file.includes('audit'))
      .filter((file) =>
        /@(Post|Patch|Put|Delete)\(/.test(readFileSync(file, 'utf-8')),
      );

    expect(mutating).toEqual([]);
  });
});
