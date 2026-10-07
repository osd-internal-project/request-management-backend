import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SourceLinks, TOOL_SOURCES } from '../common/source-links';

/**
 * CD-278 — no MCP answer without the page it came from.
 *
 * Reads the real catalogue: a tool added to it must either be listed in
 * `TOOL_SOURCES` or be an `assistant_*` tool (which links its own rows),
 * so nothing reaches a chat unlinked by omission.
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
const names = (
  JSON.parse(readFileSync(CATALOGUE, 'utf8')) as { name: string }[]
).map((tool) => tool.name);

const links = (base?: string) => new SourceLinks({ get: () => base } as never);

describe('CD-278 source links', () => {
  it.each(names.map((name) => [name] as const))(
    '%s says which page it answers from',
    (name) => {
      expect(name.startsWith('assistant_') || name in TOOL_SOURCES).toBe(true);
    },
  );

  it('names no tool the catalogue does not have', () => {
    expect(Object.keys(TOOL_SOURCES).filter((n) => !names.includes(n))).toEqual(
      [],
    );
  });

  it('links each row of a §11.1 page, and the answer to its list', () => {
    const answer = links('https://ctd.test/').attach('crm_get_opportunities', {
      data: [{ id: 'o-1' }, { title: 'no id' }],
      total: 2,
    }) as { data: Record<string, unknown>[]; source_link: string };
    expect(answer.data[0].link).toBe(
      'https://ctd.test/pages/opportunities/o-1',
    );
    expect(answer.data[1]).not.toHaveProperty('link');
    expect(answer.source_link).toBe('https://ctd.test/pages/opportunities');
  });

  it('links a single record, and a request by `request_id`', () => {
    expect(
      links('https://ctd.test').attach('crm_get_customers_id', { id: 'c-1' }),
    ).toMatchObject({ link: 'https://ctd.test/pages/customers/c-1' });
    expect(
      links('https://ctd.test').attach('request_get_requests_ref_actions', {
        request_id: 'r-1',
        actions: [],
      }),
    ).toMatchObject({ link: 'https://ctd.test/pages/requests/r-1' });
  });

  it('a bare list keeps its shape; a row is linked in place', () => {
    const answer = links('https://ctd.test').attach('crm_get_leads', [
      { id: 'l-1' },
    ]);
    expect(answer).toEqual([
      { id: 'l-1', link: 'https://ctd.test/pages/leads/l-1' },
    ]);
  });

  it('without PUBLIC_WEB_URL a link is the path, still openable from the app', () => {
    expect(links().attach('crm_get_leads_id', { id: 'l-1' })).toMatchObject({
      link: '/pages/leads/l-1',
      source_link: '/pages/leads',
    });
  });
});
