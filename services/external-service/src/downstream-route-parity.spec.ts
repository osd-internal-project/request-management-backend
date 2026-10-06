import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The post-deal routes (6 Oct 2026) are written by hand, not generated like
 * CRM's, so nothing structural stops one from drifting off its screen twin —
 * a path renamed on one side, or worse, a route here asking the acting person
 * for less than the screen asks its user. This holds every pair by name.
 *
 * Reads source, like `crm-route-parity.spec.ts` — no wiring, no database.
 *
 * The rules it asserts:
 *
 *   1. Every route in the new controllers is either paired below or is one
 *      of this service's own (`OWN`) — an unpaired route is a decision nobody
 *      wrote down.
 *   2. Each pair's screen route exists, on the same method.
 *   3. The acting person is asked for exactly what the screen asks. A screen
 *      route that is `@Authenticated()` (the service judges the row) maps to
 *      `notification.read` — the permission every role holds.
 *   4. The machine gate is the area's own `integration.<area>.read|manage`:
 *      `manage` exactly when the person is asked for a `.manage` permission.
 *   5. Every one of these controllers carries the swap and the second gate.
 */
const SRC = __dirname;
const CORE = join(__dirname, '..', '..', 'core-service', 'src');

const CONTROLLERS = [
  'presales/solutions.controller.ts',
  'legal/contracts.controller.ts',
  'pm/projects.controller.ts',
  'delivery/delivery.controller.ts',
  'support/support.controller.ts',
  'flow/flow.controller.ts',
  'assistant/assistant.controller.ts',
];

/** [external route, core file, core route] — routes as `METHOD path`. */
const PAIRS: readonly (readonly [string, string, string])[] = [
  [
    'GET presales/opportunities/:id/solutions',
    'presales/solutions.controller.ts',
    'GET opportunities/:id/solutions',
  ],
  [
    'GET presales/solutions/:id',
    'presales/solutions.controller.ts',
    'GET presales/solutions/:id',
  ],
  [
    'GET presales/solutions/:id/versions/:no',
    'presales/solutions.controller.ts',
    'GET presales/solutions/:id/versions/:no',
  ],
  [
    'GET presales/solutions/:id/versions/:no/proposal',
    'presales/solutions.controller.ts',
    'GET presales/solutions/:id/versions/:no/proposal',
  ],
  [
    'GET presales/solutions/:id/quotations',
    'presales/solutions.controller.ts',
    'GET presales/solutions/:id/quotations',
  ],

  ['GET legal/contracts', 'crm/legal-contracts.controller.ts', 'GET contracts'],
  [
    'GET legal/contracts/:id',
    'crm/legal-contracts.controller.ts',
    'GET contracts/:id',
  ],
  [
    'GET legal/contracts/:id/terms',
    'crm/legal-contracts.controller.ts',
    'GET contracts/:id/terms',
  ],
  [
    'GET legal/contracts/:id/installments',
    'crm/legal-contracts.controller.ts',
    'GET contracts/:id/installments',
  ],
  [
    'GET legal/contracts/:id/obligations',
    'crm/legal-contracts.controller.ts',
    'GET contracts/:id/obligations',
  ],

  ['GET pm/projects', 'pm/projects.controller.ts', 'GET projects'],
  [
    'GET pm/projects/openable-contracts',
    'pm/projects.controller.ts',
    'GET projects/openable-contracts',
  ],
  [
    'GET pm/projects/preview/:contractId',
    'pm/projects.controller.ts',
    'GET projects/preview/:contractId',
  ],
  [
    'GET pm/projects/by-contract/:contractId',
    'pm/projects.controller.ts',
    'GET projects/by-contract/:contractId',
  ],
  ['POST pm/projects', 'pm/projects.controller.ts', 'POST projects'],
  ['GET pm/projects/:id', 'pm/projects.controller.ts', 'GET projects/:id'],
  [
    'GET pm/projects/:id/milestones',
    'pm/projects.controller.ts',
    'GET projects/:id/milestones',
  ],

  [
    'GET delivery/projects/:projectId',
    'delivery/delivery.controller.ts',
    'GET delivery/projects/:projectId',
  ],
  [
    'GET delivery/projects/:projectId/billing',
    'delivery/delivery.controller.ts',
    'GET delivery/projects/:projectId/billing',
  ],
  [
    'GET delivery/projects/:projectId/handovers',
    'delivery/delivery.controller.ts',
    'GET delivery/projects/:projectId/handovers',
  ],

  ['GET support/assets', 'support/support.controller.ts', 'GET service-assets'],
  [
    'GET support/assets/:id',
    'support/support.controller.ts',
    'GET service-assets/:id',
  ],
  [
    'GET support/entitlements',
    'support/support.controller.ts',
    'GET service-entitlements',
  ],
  [
    'GET support/entitlements/:id',
    'support/support.controller.ts',
    'GET service-entitlements/:id',
  ],
  [
    'GET support/work-orders',
    'support/support.controller.ts',
    'GET service-work-orders',
  ],
  [
    'POST support/work-orders',
    'support/support.controller.ts',
    'POST service-work-orders',
  ],
  [
    'GET support/work-orders/by-request/:requestId',
    'support/support.controller.ts',
    'GET service-work-orders/by-request/:requestId',
  ],
  [
    'GET support/work-orders/:id',
    'support/support.controller.ts',
    'GET service-work-orders/:id',
  ],
];

/**
 * Routes with no screen twin, and the person's gate each one chose.
 *
 * `flow/opportunities/:id` composes six reads the deal page makes as cards;
 * it asks for the deal page's own `crm.sales.read`.
 */
const OWN: Readonly<Record<string, string[]>> = {
  'GET flow/opportunities/:id': ['crm.sales.read'],
  // CD-276 — the assistant's questions, each behind its screen's permission
  'GET assistant/summary': ['notification.read'],
  'GET assistant/deals/closing': ['crm.sales.read'],
  'GET assistant/deals/silent': ['crm.sales.read'],
  'GET assistant/approvals': ['approval.decide'],
  'GET assistant/projects/at-risk': ['notification.read'],
  'GET assistant/service-jobs': ['service.asset.read'],
  'GET assistant/kb/articles': ['notification.read'],
};

interface Route {
  /** `METHOD path`, path without leading or trailing slash. */
  readonly key: string;
  readonly permissions: string[] | null;
  readonly acting: string[] | null;
  readonly authenticated: boolean;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function args(list: string | undefined): string[] | null {
  if (list === undefined) return null;
  return [...list.matchAll(/'([^']+)'/g)].map(([, value]) => value);
}

function joinPath(prefix: string, path: string): string {
  return [prefix, path].filter(Boolean).join('/');
}

/**
 * Every route in a file, under the prefix of the `@Controller` it sits in —
 * `support.controller.ts` holds a dozen controllers. A route's decorators are
 * those between its `@Get|@Post…` and its method's name; this codebase writes
 * `@Permissions` beneath the route decorator, which `route-guards.spec.ts`
 * relies on too.
 */
function routesIn(file: string): Route[] {
  const source = stripComments(readFileSync(file, 'utf8'));
  const routes: Route[] = [];

  for (const segment of source.split(/@Controller\(/).slice(1)) {
    const prefix = /^\s*(?:'([^']*)')?\s*\)/.exec(segment)?.[1] ?? '';
    const pattern = /@(Get|Post|Patch|Put|Delete)\((?:'([^']*)')?\)/g;

    for (const match of segment.matchAll(pattern)) {
      const rest = segment.slice((match.index ?? 0) + match[0].length);
      const end = rest.search(/\n\s+(?:async\s+)?[a-zA-Z]\w*\(/);
      const block = end === -1 ? rest : rest.slice(0, end);

      routes.push({
        key: `${match[1].toUpperCase()} ${joinPath(prefix, match[2] ?? '')}`,
        permissions: args(/@Permissions\(([^)]*)\)/.exec(block)?.[1]),
        acting: args(/@ActingPermissions\(([^)]*)\)/.exec(block)?.[1]),
        authenticated: /@Authenticated\(\)/.test(block),
      });
    }
  }

  return routes;
}

const external = new Map(
  CONTROLLERS.flatMap((file) => routesIn(join(SRC, file))).map((route) => [
    route.key,
    route,
  ]),
);

describe('the post-deal external surface corresponds to the screens', () => {
  it('pairs every route or names it as its own', () => {
    const declared = new Set([
      ...PAIRS.map(([key]) => key),
      ...Object.keys(OWN),
    ]);

    expect([...external.keys()].sort()).toEqual([...declared].sort());
  });

  it.each(PAIRS)(
    '%s → %s %s exists on the screen side',
    (key, file, coreKey) => {
      const core = routesIn(join(CORE, file)).find((r) => r.key === coreKey);

      expect(core).toBeDefined();
      expect(key.split(' ')[0]).toBe(coreKey.split(' ')[0]);
    },
  );

  it.each(PAIRS)(
    '%s asks the acting person for what the screen asks',
    (key, file, coreKey) => {
      const core = routesIn(join(CORE, file)).find((r) => r.key === coreKey)!;
      const wanted = core.authenticated
        ? ['notification.read']
        : (core.permissions ?? []);

      expect(external.get(key)?.acting).toEqual(wanted);
    },
  );

  it.each(Object.entries(OWN))(
    '%s asks the acting person for its stated permission',
    (key, wanted) => {
      expect(external.get(key)?.acting).toEqual(wanted);
    },
  );

  it("fronts each route with its area's machine gate", () => {
    for (const route of external.values()) {
      const area = route.key.split(' ')[1].split('/')[0];
      const writes = (route.acting ?? []).some((p) => p.endsWith('.manage'));
      const gate = `integration.${area}.${writes ? 'manage' : 'read'}`;

      expect({ route: route.key, gate: route.permissions }).toEqual({
        route: route.key,
        gate: [gate],
      });
    }
  });

  it('applies the swap and the second gate to every controller', () => {
    for (const file of CONTROLLERS) {
      expect(readFileSync(join(SRC, file), 'utf8')).toContain(
        '@ActsForPerson()',
      );
    }
  });
});
