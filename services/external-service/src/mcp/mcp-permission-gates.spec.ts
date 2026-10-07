import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  ALL_PERMISSIONS,
  SensitiveFieldMasker,
  type Principal,
} from '@request-management/share';
import { SourceLinks } from '../common/source-links';
import { McpToolRegistry } from './mcp-tools';

/**
 * CD-277 — every MCP tool answers as the person asking, and only as far as
 * that person's screens would.
 *
 * Runs over the **real** `external-tools.json`, not a fixture: a tool added
 * tomorrow is covered the moment the catalogue lists it. What it holds:
 *
 *   1. Every tool declares the person's permission (the one exception is the
 *      action route, which checks per action inside `perform`).
 *   2. A person without it is refused before anything is called.
 *   3. With it, the call reaches a service carrying that very person — never
 *      a service account, never a principal built somewhere in between. That
 *      is what puts SCOPE-02's row filter and SCOPE-03's 404 on every tool:
 *      they live in the services, keyed on the principal they are handed.
 *
 * Whether the services then filter correctly against a real database is
 * `test/mcp-scope.e2e-spec.ts`, run by `make smoke`.
 */

const CATALOGUE = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'docs',
  'openapi',
  'external-tools.json',
);

interface Spec {
  name: string;
  'x-acting-permission': string[];
}

/** The one route whose permission depends on the action it is asked for. */
const CHECKS_INSIDE = ['request_post_requests_ref_actions_action'];

const specs = JSON.parse(readFileSync(CATALOGUE, 'utf8')) as Spec[];

function person(permissions: readonly string[]): Principal {
  return {
    userId: 'u-person',
    activeCompanyId: 'company-a',
    permissions,
    isServiceAccount: false,
    sensitiveFieldsAll: [],
    sensitiveFieldsVisible: [],
  } as unknown as Principal;
}

/** Arguments that satisfy every handler's required fields. */
const ARGS = {
  id: 'x',
  ref: 'REQ-1',
  code: 'IT',
  action: 'cancel',
  q: 'vpn',
  docNo: 'FI05-1',
};

/** A service whose every method records its arguments and answers `{}`. */
function recorder(calls: unknown[][]) {
  return new Proxy(
    {},
    {
      get: () =>
        jest.fn((...args: unknown[]) => {
          calls.push(args);
          return Promise.resolve({});
        }),
    },
  );
}

function registry(calls: unknown[][]): McpToolRegistry {
  const service = () => recorder(calls) as never;
  const built = new McpToolRegistry(
    service(),
    new SensitiveFieldMasker(),
    service(),
    service(),
    service(),
    service(),
    service(),
    service(),
    service(),
    new SourceLinks({ get: () => 'https://ctd.test' } as never),
  );
  built.onModuleInit();
  return built;
}

describe('CD-277 MCP permission gates, per tool', () => {
  it('reads the real catalogue', () => {
    const calls: unknown[][] = [];
    expect(registry(calls).list().length).toBe(specs.length);
    expect(specs.length).toBeGreaterThan(30);
  });

  it.each(specs.map((spec) => [spec.name, spec] as const))(
    '%s declares the person’s permission',
    (name, spec) => {
      if (CHECKS_INSIDE.includes(name)) return;
      expect(spec['x-acting-permission'].length).toBeGreaterThan(0);
    },
  );

  it.each(
    specs
      .filter((spec) => !CHECKS_INSIDE.includes(spec.name))
      .map((spec) => [spec.name] as const),
  )('%s refuses a person without it, before calling anything', async (name) => {
    const calls: unknown[][] = [];
    await expect(
      registry(calls).call(
        name,
        { ...ARGS },
        {
          actor: person([]),
          authorization: '',
        },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(calls).toHaveLength(0);
  });

  it.each(specs.map((spec) => [spec.name] as const))(
    '%s reaches its service as that same person',
    async (name) => {
      const calls: unknown[][] = [];
      const actor = person(ALL_PERMISSIONS);
      await registry(calls).call(
        name,
        { ...ARGS },
        {
          actor,
          authorization: '',
        },
      );
      expect(calls.length).toBeGreaterThan(0);
      // The person object itself, or (for a company-wide lookup such as the
      // lead statuses) that person's own company — nothing else.
      expect(
        calls.some((args) =>
          args.some((arg) => arg === actor || arg === actor.activeCompanyId),
        ),
      ).toBe(true);
    },
  );
});

/**
 * "No tool reads a mart table or a summary report around the permissions."
 *
 * The mart (`mart.*`), the data lake and the Metabase embeds are built for
 * dashboards and carry no per-person row scope — a chat reading them would
 * answer one salesperson with the whole company's pipeline. The files behind
 * MCP may not reach them; figures come from the live tables through the
 * screens' own services instead.
 */
describe('CD-277 no tool reads around the row scope', () => {
  const ROOTS = [__dirname, join(__dirname, '..', 'assistant')];
  const FORBIDDEN = [
    /\bmart\./i,
    /Mart(Repository|Service|Tables?)\b/,
    /\bLake\w*(Repository|Service|Client)\b/,
    /Metabase/i,
    /CampaignResults/,
    /PricingAnalytics/,
    /data-mart|campaign-mart|lake-sources/,
  ];

  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) return files(path);
      return entry.endsWith('.ts') && !entry.endsWith('.spec.ts') ? [path] : [];
    });

  it.each(ROOTS.flatMap(files).map((path) => [path] as const))(
    '%s touches no mart, lake or embed',
    (path) => {
      const source = readFileSync(path, 'utf8');
      for (const pattern of FORBIDDEN) expect(source).not.toMatch(pattern);
    },
  );
});
