import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * การเบิก is served to screens by core-service and to machines here; this
 * fails the build when the two copies stop agreeing on a route or on what
 * it asks of the acting user (same reasoning as crm-route-parity.spec.ts).
 */
const CORE = join(
  __dirname,
  '..',
  '..',
  '..',
  'core-service',
  'src',
  'disbursement',
  'disbursement.controller.ts',
);
const EXTERNAL = join(__dirname, 'disbursement.controller.ts');

/** The machine gate that fronts each screen permission. */
const ROBOT: Readonly<Record<string, string>> = {
  'request.read': 'integration.disbursement.read',
  'request.create': 'integration.disbursement.manage',
  'disbursement.verify': 'integration.disbursement.manage',
  'disbursement.pay': 'integration.disbursement.manage',
};

interface Route {
  readonly controller: string;
  readonly method: string;
  readonly path: string;
  readonly permission: string;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function routesIn(file: string, decorator: string): Route[] {
  const source = stripComments(readFileSync(file, 'utf8'));
  const routes: Route[] = [];
  for (const block of source.split(/@Controller\(/).slice(1)) {
    // The external port puts every module under its own prefix, as `crm/` does.
    const controller = (/^'([^']*)'/.exec(block)?.[1] ?? '').replace(
      /^disbursement\//,
      '',
    );
    const pattern = new RegExp(
      `@(Get|Post|Patch|Put|Delete)\\((?:'([^']*)')?\\)[\\s\\S]{0,400}?@${decorator}\\('([\\w.]+)'\\)`,
      'g',
    );
    for (const [, method, path, permission] of block.matchAll(pattern)) {
      routes.push({ controller, method, path: path ?? '', permission });
    }
  }
  return routes;
}

const shape = (routes: Route[], withPermission: boolean) =>
  routes
    .map(
      (r) =>
        `${r.method} ${r.controller}/${r.path}` +
        (withPermission ? ` -> ${r.permission}` : ''),
    )
    .sort();

describe('the external disbursement surface corresponds to the screens', () => {
  const core = routesIn(CORE, 'Permissions');
  const acting = routesIn(EXTERNAL, 'ActingPermissions');
  const robot = routesIn(EXTERNAL, 'Permissions');

  it('serves every screen route, one for one', () => {
    expect(core.length).toBeGreaterThan(0);
    expect(shape(acting, false)).toEqual(shape(core, false));
  });

  it('asks the acting user for exactly what the screen asks its user', () => {
    expect(shape(acting, true)).toEqual(shape(core, true));
  });

  it('fronts every screen permission with its own machine gate', () => {
    expect(robot.length).toBe(acting.length);
    robot.forEach((route, i) => {
      expect(route.permission).toBe(ROBOT[acting[i].permission]);
    });
  });

  it('applies the swap and the second gate', () => {
    const source = readFileSync(EXTERNAL, 'utf8');
    expect(source).toContain('@ServiceAccountOnly()');
    expect(source).toContain('@UseGuards(ActingUserGuard, ActingPolicyGuard)');
  });
});
