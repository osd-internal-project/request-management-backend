import type { Principal } from '@request-management/share';
import { SmartScreeningService } from './smart-screening.service';

const actor = {
  userId: 'u-ops',
  activeCompanyId: 'osd',
  permissions: ['smart.prospect.manage'],
} as unknown as Principal;

const prospect = (overrides: Record<string, unknown> = {}) => ({
  id: 'p-1',
  companyId: 'osd',
  sourceId: 'src-1',
  name: 'บริษัท ระยองพาร์ท จำกัด',
  taxId: '0105551234567',
  phone: '038123456',
  email: null,
  website: null,
  industry: 'ชิ้นส่วนยานยนต์',
  province: 'ระยอง',
  registeredCapital: '20000000',
  salesAxis: 'getter',
  evidence: { url: 'https://example.com/x' },
  status: 'new',
  score: null,
  matchKind: null,
  ...overrides,
});

function harness(
  options: {
    customer?: { id: string } | null;
    lead?: { id: string } | null;
    rows?: unknown[];
    llmMode?: string;
  } = {},
) {
  const prospects = {
    findMany: jest.fn(() => Promise.resolve(options.rows ?? [prospect()])),
    update: jest.fn(() => Promise.resolve({})),
  };
  const sources = {
    findMany: jest.fn(() =>
      Promise.resolve([
        {
          id: 'src-1',
          code: 'DBD-EAST',
          criteria: { keywords: ['ยานยนต์'], provinces: ['ระยอง'] },
        },
      ]),
    ),
  };
  const customers = {
    findFirst: jest.fn(() => Promise.resolve(options.customer ?? null)),
  };
  const leads = {
    findFirst: jest.fn(() => Promise.resolve(options.lead ?? null)),
  };
  const statuses = {
    listAll: jest.fn(() =>
      Promise.resolve([
        { code: 'new', kind: 'open' },
        { code: 'lost', kind: 'closed' },
      ]),
    ),
  };
  const intake = {
    receive: jest.fn(() =>
      Promise.resolve({ outcome: 'created', lead: { id: 'lead-9' } }),
    ),
  };
  const llm = {
    chat: jest.fn(() =>
      Promise.resolve({ text: 'น่าจะต้องการระบบกล้องในโรงงาน' }),
    ),
  };
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const service = new SmartScreeningService(
    prospects as never,
    sources as never,
    customers as never,
    leads as never,
    statuses as never,
    intake as never,
    llm as never,
    { get: () => options.llmMode ?? 'mock' } as never,
    audit as never,
    { execute: jest.fn((fn: (p: unknown) => unknown) => fn({})) } as never,
  );
  return { service, prospects, intake, llm, audit, leads };
}

const updated = (h: ReturnType<typeof harness>) =>
  (
    h.prospects.update.mock.calls[0] as unknown as [
      { data: Record<string, unknown> },
    ]
  )[0].data;

describe('CD-290 screening swept businesses', () => {
  it('scores by the rules against the source’s criteria and marks it screened', async () => {
    const h = harness();
    await h.service.screen('osd', ['p-1']);
    expect(updated(h)).toMatchObject({
      status: 'screened',
      score: 80,
      matchKind: 'none',
    });
    expect(h.llm.chat).not.toHaveBeenCalled();
  });

  it('an existing customer is matched (for Keeper); an open Lead pulls the score down', async () => {
    const asCustomer = harness({ customer: { id: 'c-1' } });
    await asCustomer.service.screen('osd', ['p-1']);
    expect(updated(asCustomer)).toMatchObject({
      matchKind: 'customer',
      matchCustomerId: 'c-1',
    });
    const asLead = harness({ lead: { id: 'l-1' } });
    await asLead.service.screen('osd', ['p-1']);
    expect(updated(asLead)).toMatchObject({
      matchKind: 'lead',
      matchLeadId: 'l-1',
      score: 40,
    });
    // only open, unconverted Leads count
    expect(asLead.leads.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ['new'] },
          convertedOpportunityId: null,
        }) as unknown,
      }),
    );
  });

  it('with a real gateway the model adds a summary; the number stays the rules’', async () => {
    const h = harness({ llmMode: 'gateway' });
    await h.service.screen('osd', ['p-1']);
    expect(h.llm.chat).toHaveBeenCalledWith(
      { companyId: 'osd', task: 'smart.score' },
      expect.any(Array),
      { maxTokens: 200 },
    );
    expect(updated(h)).toMatchObject({
      score: 80,
      aiSummary: 'น่าจะต้องการระบบกล้องในโรงงาน',
    });
  });

  it('a model that refuses (quota, switched off) leaves no summary and still screens', async () => {
    const h = harness({ llmMode: 'gateway' });
    h.llm.chat.mockRejectedValueOnce(new Error('quota'));
    await h.service.screen('osd', ['p-1']);
    expect(updated(h).status).toBe('screened');
    expect(updated(h)).not.toHaveProperty('aiSummary');
  });

  it('sending goes through the campaign screening and is audited', async () => {
    const h = harness({ rows: [prospect({ status: 'screened', score: 80 })] });
    const results = await h.service.send(actor, ['p-1']);
    expect(results).toEqual([
      {
        id: 'p-1',
        name: 'บริษัท ระยองพาร์ท จำกัด',
        outcome: 'created',
        lead_id: 'lead-9',
      },
    ]);
    expect(h.intake.receive).toHaveBeenCalledWith(
      expect.objectContaining({
        source_code: 'ai_smart',
        tax_id: '0105551234567',
        note: expect.stringContaining('คะแนนความพร้อม 80/100') as unknown,
      }),
      actor,
    );
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'smart.prospect.sent' }),
      expect.anything(),
    );
  });

  it('a sent or discarded row is skipped; an unknown id is 404', async () => {
    const h = harness({ rows: [prospect({ status: 'discarded' })] });
    await expect(h.service.send(actor, ['p-1'])).resolves.toEqual([
      expect.objectContaining({ outcome: 'skipped', reason: 'ถูกทิ้งไปแล้ว' }),
    ]);
    expect(h.intake.receive).not.toHaveBeenCalled();
    const none = harness({ rows: [] });
    await expect(none.service.send(actor, ['p-x'])).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
