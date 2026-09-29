import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * CRM is served twice — to screens by core-service, to machines by this
 * service — and the second copy is generated from the first.
 *
 * That copy is the cost of exposing CRM externally at all. Nest registers the
 * controllers of every module it imports, so this service cannot reuse
 * core's CRM controllers without also putting `api/v1/customers` on the
 * external port (see `services/core-service/src/index.ts`). It therefore
 * declares its own, from the generator, which means the two sides can drift:
 * somebody adds a route to a screen and nobody adds it here, or the pair stop
 * agreeing about which permission a route needs.
 *
 * This asserts the correspondence so that drift fails the build rather than
 * shipping as a silently missing endpoint or, worse, a route on the external
 * port asking for less than its screen does.
 *
 * It reads source, like `route-guards.spec.ts` — no wiring, no database.
 */
const CORE_CRM = join(
  __dirname,
  '..',
  '..',
  '..',
  'core-service',
  'src',
  'crm',
);
const EXTERNAL_CRM = __dirname;

/** The machine gate that fronts each screen permission. */
const ROBOT: Readonly<Record<string, string>> = {
  'crm.customer.read': 'integration.crm.customer.read',
  'crm.customer.manage': 'integration.crm.customer.manage',
  'crm.customer.financial.read': 'integration.crm.customer.read',
  'crm.sales.read': 'integration.crm.sales.read',
  'crm.sales.manage': 'integration.crm.sales.manage',
  'crm.target.manage': 'integration.crm.sales.manage',
  'crm.campaign.manage': 'integration.crm.sales.manage',
  'admin.crm.manage': 'integration.crm.admin.manage',
};

/**
 * The two robot-only routes, excluded by name.
 *
 * `integrations/crm/leads` has no person at the other end — a customer's web
 * form, and a workflow engine applying a stage it already decided. They moved
 * here wholesale rather than being generated, so they have no screen route to
 * correspond to.
 */
const ROBOT_ONLY = ['lead-intake.controller.ts', 'lead-workflow.controller.ts'];

/**
 * The mirror case: screen routes deliberately not on the external port,
 * excluded by name so each one is a stated decision rather than a gap.
 *
 * `activity-photos` (CD-75) — photos a salesperson takes on the phone after a
 * visit. No partner system has visit photos to send, and the routes are
 * multipart uploads the generator does not carry.
 *
 * `handovers` (CD-84) — one team handing work to another inside the company;
 * the receiving side is gated on team membership, which no integration has.
 */
const SCREEN_ONLY = [
  'activity-photos.controller.ts',
  'handovers.controller.ts',
];

interface Route {
  readonly method: string;
  readonly path: string;
  readonly permission: string;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/**
 * Every route in a controller file, paired with the permission declared
 * directly beneath it.
 *
 * `@Permissions` is always written immediately after the route decorator in
 * this codebase, which is the same assumption `route-guards.spec.ts` relies on
 * to tell a class-level guard from a method-level one.
 */
function routesIn(file: string, dir: string, decorator: string): Route[] {
  const source = stripComments(readFileSync(join(dir, file), 'utf8'));
  const pattern = new RegExp(
    `@(Get|Post|Patch|Put|Delete)\\((?:'([^']*)')?\\)[\\s\\S]{0,400}?@${decorator}\\('([\\w.]+)'\\)`,
    'g',
  );

  return [...source.matchAll(pattern)].map(([, method, path, permission]) => ({
    method,
    path: path ?? '',
    permission,
  }));
}

function controllersIn(dir: string): string[] {
  return readdirSync(dir)
    .filter(
      (f) => f.endsWith('.controller.ts') || f.endsWith('.controllers.ts'),
    )
    .filter((f) => !f.endsWith('.spec.ts'))
    .filter((f) => !ROBOT_ONLY.includes(f))
    .filter((f) => !SCREEN_ONLY.includes(f));
}

/** `sales.controllers.ts` on one side, `sales.controller.ts` on the other. */
function key(file: string): string {
  return file.replace('.controllers.ts', '').replace('.controller.ts', '');
}

function index(dir: string, decorator: string): Map<string, Route[]> {
  const byKey = new Map<string, Route[]>();

  for (const file of controllersIn(dir)) {
    byKey.set(key(file), routesIn(file, dir, decorator));
  }

  return byKey;
}

describe('the external CRM surface corresponds to the screens', () => {
  const core = index(CORE_CRM, 'Permissions');
  const external = index(EXTERNAL_CRM, 'ActingPermissions');

  it('covers the same controllers', () => {
    expect([...external.keys()].sort()).toEqual([...core.keys()].sort());
  });

  it('serves the same route on the same method, one for one', () => {
    for (const [name, coreRoutes] of core) {
      const shape = (routes: Route[]) =>
        routes.map((r) => `${r.method} ${r.path}`).sort();

      expect(shape(external.get(name) ?? [])).toEqual(shape(coreRoutes));
    }
  });

  /*
    The point of the whole exercise. A route whose acting permission is weaker
    than its screen's would let an integration do, in somebody's name, what
    that person cannot do for themselves.
  */
  it('asks the acting user for exactly what the screen asks its user', () => {
    for (const [name, coreRoutes] of core) {
      const asked = (routes: Route[]) =>
        routes.map((r) => `${r.method} ${r.path} -> ${r.permission}`).sort();

      expect(asked(external.get(name) ?? [])).toEqual(asked(coreRoutes));
    }
  });

  it('fronts every screen permission with its own machine gate', () => {
    for (const file of controllersIn(EXTERNAL_CRM)) {
      const robot = routesIn(file, EXTERNAL_CRM, 'Permissions');
      const acting = routesIn(file, EXTERNAL_CRM, 'ActingPermissions');

      expect(robot.length).toBe(acting.length);

      robot.forEach((route, i) => {
        expect(route.permission).toBe(ROBOT[acting[i].permission]);
      });
    }
  });

  it('applies the swap and the second gate to every generated controller', () => {
    for (const file of controllersIn(EXTERNAL_CRM)) {
      const source = readFileSync(join(EXTERNAL_CRM, file), 'utf8');

      expect(source).toContain(
        '@UseGuards(ActingUserGuard, ActingPolicyGuard)',
      );
      expect(source).toContain('@ServiceAccountOnly()');
    }
  });
});
