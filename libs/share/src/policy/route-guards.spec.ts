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
 * module wiring, and it covers every service from one place.
 *
 * `@ActingPermissions` is **not** in `GUARD` below, and must not be added.
 * It declares what the person an integration acts for may do — a second gate
 * *behind* the first, never a substitute for it. Counting it as a guard would
 * let a route on the external port declare only the human's permission and
 * pass this check while the machine's gate was missing, which is the one
 * mistake on that surface that matters most.
 */
const SERVICES = join(__dirname, '..', '..', '..', '..', 'services');

const ROUTE = /@(Get|Post|Patch|Put|Delete)\(/g;
// `AnyPermission` counts: it declares access just as explicitly as the rest.
// Leaving it out silently reclassified two guarded routes as open the day it
// was introduced — which is precisely what this file exists to catch.
const GUARD = /@(Permissions|AnyPermission|Public|Authenticated)\(/g;

/**
 * Source with comments removed.
 *
 * Both patterns below are text searches, so a decorator *named in a doc
 * comment* counts as one that is applied. That was harmless while the counts
 * only had to reach a threshold; it stopped being harmless when a class-level
 * guard began exempting a whole file — `InternalPrincipalController`
 * explains its own gating in prose, and the prose alone would have exempted
 * it.
 *
 * Strings are left alone: a decorator name inside one is not a thing this
 * codebase writes, and stripping them properly needs a parser.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

interface Controller {
  readonly file: string;
  readonly routes: number;
  readonly guards: number;
  /** True when a guard is declared on the class, covering every route in it. */
  readonly guardedAtClassLevel: boolean;
}

/**
 * Whether a guard decorator sits on the controller class rather than a method.
 *
 * Nest resolves `@Permissions` with `getAllAndOverride([handler, class])`, so
 * one on the class applies to every route in it — which is how
 * `ExternalController` declares that all of its routes need the integration
 * permission, without repeating the same line eight times.
 *
 * A decorator is class-level exactly when it appears **before the first route
 * decorator** in the file. That holds because a method's decorators are
 * written `@Get(...)` first and the guard beneath it, everywhere in this
 * codebase — so nothing above the first `@Get` can belong to a method.
 */
function hasClassLevelGuard(source: string): boolean {
  const firstRoute = source.search(/@(Get|Post|Patch|Put|Delete)\(/);
  if (firstRoute === -1) return false;

  return /@(Permissions|AnyPermission|Public|Authenticated)\(/.test(
    source.slice(0, firstRoute),
  );
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
    const source = withoutComments(readFileSync(file, 'utf-8'));

    return {
      file: file.slice(SERVICES.length + 1),
      routes: source.match(ROUTE)?.length ?? 0,
      guards: source.match(GUARD)?.length ?? 0,
      guardedAtClassLevel: hasClassLevelGuard(source),
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
      // one route has none, unless the class itself declares one.
      if (controller.guardedAtClassLevel) return;

      expect(controller.guards).toBeGreaterThanOrEqual(controller.routes);
    },
  );

  it('leaves nothing unguarded across any service', () => {
    const unguarded = controllers.filter(
      (c) => !c.guardedAtClassLevel && c.guards < c.routes,
    );

    expect(unguarded.map((c) => c.file)).toEqual([]);
  });

  /*
    The class-level shortcut is only safe while it is rare and deliberate.
    Named here so that a controller acquiring one is a visible edit rather
    than a quiet way past the check above.

    Only `mcp.controller.ts` (one route; its `@AnyPermission` sits on the
    class because the tool name is in the body rather than the path).
    `request.controller.ts` left this list on 22 Oct 2026: its key scope now
    follows each route's acting permission (`integration.request.read` …).

    The generated CRM controllers are deliberately *not* here: their routes
    differ in whether they read or write, so each declares its own gate.
  */
  it('names every controller relying on a class-level guard', () => {
    expect(
      controllers
        .filter((c) => c.guardedAtClassLevel)
        .map((c) => c.file)
        .sort(),
    ).toEqual([
      'external-service/src/mcp/mcp.controller.ts',
    ]);
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
