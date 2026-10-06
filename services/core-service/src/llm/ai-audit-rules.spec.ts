import {
  auditArgs,
  auditResult,
  isWriteTool,
  MAX_ARG_LENGTH,
  retentionCutoff,
} from './ai-audit-rules';

describe('CD-279 AI audit rules', () => {
  it('tells writes from reads by the tool name', () => {
    expect(isWriteTool('crm_post_leads')).toBe(true);
    expect(isWriteTool('crm_patch_leads_id_owner')).toBe(true);
    expect(isWriteTool('crm_get_leads')).toBe(false);
    expect(isWriteTool('assistant_get_summary')).toBe(false);
  });

  it('keeps a read’s filters, cut short; a write’s field names only', () => {
    const read = auditArgs('crm_get_leads', {
      search: 'x'.repeat(500),
      page: 2,
      filter: { nested: true },
    });
    expect((read.search as string).length).toBe(MAX_ARG_LENGTH + 1);
    expect(read.page).toBe(2);
    expect(read.filter).toBe('[object]');
    expect(
      auditArgs('crm_post_leads', { phone: '0812345678', name: 'ก' }),
    ).toEqual({ fields: ['name', 'phone'] });
  });

  it('reads row ids and counts from every answer shape', () => {
    expect(
      auditResult({ data: [{ id: 'a' }, { id: 'b' }], total: 40 }),
    ).toEqual({ ids: ['a', 'b'], count: 40 });
    expect(
      auditResult({ items: [{ link: 'https://x/pages/kb/k-1' }] }),
    ).toEqual({ ids: ['k-1'], count: 1 });
    expect(auditResult([{ id: 'l-1' }])).toEqual({ ids: ['l-1'], count: 1 });
    expect(auditResult({ request_id: 'r-1', actions: [] })).toEqual({
      ids: ['r-1'],
      count: 1,
    });
    expect(
      auditResult({
        silent: { total: 1, items: [{ link: '/pages/opportunities/o-1' }] },
        follow_up_overdue: { total: 0, items: [] },
        source_link: '/pages/opportunities',
      }),
    ).toEqual({ ids: ['o-1'], count: 1 });
  });

  it('a summary has figures, not rows', () => {
    expect(
      auditResult({ requests: { open_total: 3, link: '/pages/requests' } }),
    ).toEqual({ ids: [], count: 0 });
  });

  it('cuts off retentionDays before now', () => {
    const now = new Date('2026-10-06T00:00:00Z');
    expect(retentionCutoff(30, now).toISOString()).toBe(
      '2026-09-06T00:00:00.000Z',
    );
  });
});
