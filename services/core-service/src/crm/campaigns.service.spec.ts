import { Prisma } from '@prisma/client';
import { AppError } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { CampaignsService } from './campaigns.service';
import { LeadImportService } from './lead-import.service';

function principal(): Principal {
  return {
    userId: 'u-mkt',
    username: 'mkt',
    displayName: 'การตลาด',
    activeCompanyId: 'company-osd',
    orgUnitId: null,
    permissions: ['crm.sales.read', 'crm.campaign.manage'],
    ledUnitIds: [],
    scopedUnitIds: [],
    isServiceAccount: false,
  } as unknown as Principal;
}

const campaignRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'cmp-1',
  code: 'EXPO-2026',
  name: 'งานอีเวนต์',
  channel: 'อีเวนต์',
  startDate: new Date('2026-10-01T00:00:00Z'),
  endDate: new Date('2026-10-31T00:00:00Z'),
  budget: new Prisma.Decimal(100_000),
  note: null,
  active: true,
  createdAt: new Date(),
  ...overrides,
});

function harness(
  options: {
    found?: unknown;
    rows?: unknown[];
    leads?: unknown[];
    orders?: unknown[];
    createFails?: Error;
  } = {},
) {
  const leadWheres: Record<string, unknown>[] = [];
  const campaigns = {
    findFirst: jest.fn(() => Promise.resolve(options.found ?? null)),
    findMany: jest.fn(() => Promise.resolve(options.rows ?? [])),
    create: jest.fn(() =>
      options.createFails
        ? Promise.reject(options.createFails)
        : Promise.resolve({ id: 'cmp-new' }),
    ),
    update: jest.fn(() => Promise.resolve({})),
  };
  const leads = {
    findMany: jest.fn((args: { where: Record<string, unknown> }) => {
      leadWheres.push(args.where);
      return Promise.resolve(options.leads ?? []);
    }),
  };
  const saleOrders = {
    findMany: jest.fn(() => Promise.resolve(options.orders ?? [])),
  };
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const service = new CampaignsService(
    campaigns as never,
    leads as never,
    saleOrders as never,
    audit as never,
  );
  return { service, campaigns, audit, leadWheres };
}

describe('CD-71 CampaignsService.resolveCode', () => {
  it('not sent → untouched; blank → cleared', async () => {
    const { service, campaigns } = harness();
    await expect(service.resolveCode(undefined, 'c')).resolves.toBeUndefined();
    await expect(service.resolveCode('  ', 'c')).resolves.toBeNull();
    await expect(service.resolveCode(null, 'c')).resolves.toBeNull();
    expect(campaigns.findFirst).not.toHaveBeenCalled();
  });

  it('matches case-insensitively within the company', async () => {
    const { service, campaigns } = harness({
      found: { id: 'cmp-1', active: true },
    });
    await expect(
      service.resolveCode(' expo-2026 ', 'company-osd'),
    ).resolves.toBe('cmp-1');
    expect(campaigns.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { companyId: 'company-osd', code: 'EXPO-2026' },
      }),
    );
  });

  it('an unknown code is refused, never silently dropped', async () => {
    const { service } = harness({ found: null });
    await expect(service.resolveCode('NOPE', 'c')).rejects.toThrow(
      'ไม่พบแคมเปญรหัส NOPE',
    );
  });

  it('a closed campaign takes no new leads', async () => {
    const { service } = harness({ found: { id: 'cmp-1', active: false } });
    await expect(service.resolveCode('EXPO-2026', 'c')).rejects.toThrow(
      'ปิดแล้ว',
    );
  });
});

describe('CD-71 CampaignsService', () => {
  it('CD-71: results — leads, converted, won, sales, cost per lead, sales per budget', async () => {
    const { service, leadWheres } = harness({
      rows: [
        campaignRow(),
        campaignRow({ id: 'cmp-2', code: 'ADS', budget: null }),
      ],
      leads: [
        {
          campaignId: 'cmp-1',
          convertedOpportunityId: 'opp-1',
          convertedOpportunity: { stage: 'won' },
        },
        {
          campaignId: 'cmp-1',
          convertedOpportunityId: 'opp-2',
          convertedOpportunity: { stage: 'proposing' },
        },
        {
          campaignId: 'cmp-1',
          convertedOpportunityId: null,
          convertedOpportunity: null,
        },
        {
          campaignId: 'cmp-1',
          convertedOpportunityId: null,
          convertedOpportunity: null,
        },
        {
          campaignId: 'cmp-2',
          convertedOpportunityId: null,
          convertedOpportunity: null,
        },
      ],
      orders: [{ opportunityId: 'opp-1', amount: new Prisma.Decimal(300_000) }],
    });

    const result = await service.list({}, principal());

    expect(result[0]).toMatchObject({
      code: 'EXPO-2026',
      start_date: '2026-10-01',
      budget: 100_000,
      stats: {
        leads: 4,
        converted: 2,
        won: 1,
        sales_amount: 300_000,
        cost_per_lead: 25_000,
        sales_per_budget: 3,
      },
    });
    // no budget → no ratios, not zero
    expect(result[1].stats).toMatchObject({
      leads: 1,
      cost_per_lead: null,
      sales_per_budget: null,
    });
    // SCOPE-02: counted through the lead visibility filter
    expect((leadWheres[0].AND as unknown[])[0]).toMatchObject({
      companyId: 'company-osd',
    });
  });

  it('CD-71: codes are stored upper-case and audited on create', async () => {
    const { service, campaigns, audit } = harness();

    await service.create(
      { code: 'expo-2026', name: 'งาน', budget: 5000 },
      principal(),
    );

    expect(campaigns.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ code: 'EXPO-2026' }) as unknown,
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'crm.campaign.created' }),
    );
  });

  it('CD-71: a duplicate code is a validation error, not a 500', async () => {
    const { service } = harness({
      createFails: new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    });
    await expect(
      service.create({ code: 'EXPO', name: 'x' }, principal()),
    ).rejects.toThrow('มีอยู่แล้ว');
  });

  it('CD-71: start after end is refused', async () => {
    const { service, campaigns } = harness();
    await expect(
      service.create(
        {
          code: 'X',
          name: 'x',
          start_date: '2026-11-01',
          end_date: '2026-10-01',
        },
        principal(),
      ),
    ).rejects.toThrow('วันเริ่มต้องไม่เกินวันจบ');
    expect(campaigns.create).not.toHaveBeenCalled();
  });

  it('SCOPE-03: another company’s campaign answers 404 on update', async () => {
    const { service, campaigns } = harness({ found: null });
    await expect(
      service.update('cmp-other', { active: false }, principal()),
    ).rejects.toThrow('ไม่พบแคมเปญนี้');
    expect(campaigns.update).not.toHaveBeenCalled();
  });
});

describe('CD-71 lead import with campaign codes', () => {
  function importHarness(resolve: (code: string) => Promise<string | null>) {
    const created: Record<string, unknown>[] = [];
    const leads = {
      findFirst: jest.fn(() => Promise.resolve(null)),
      create: jest.fn((args: { data: Record<string, unknown> }) => {
        created.push(args.data);
        return Promise.resolve({ id: `lead-${created.length}` });
      }),
    };
    const campaigns = { resolveCode: jest.fn(resolve) };
    const service = new LeadImportService(
      leads as never,
      { record: jest.fn(() => Promise.resolve()) } as never,
      {
        execute: jest.fn((work: (p: unknown) => Promise<unknown>) => work({})),
      } as never,
      { defaultCode: jest.fn(() => Promise.resolve('new')) } as never,
      campaigns as never,
    );
    return { service, campaigns, created };
  }

  it('CD-71: resolves each code once, links good rows, reports bad codes per row', async () => {
    const { service, campaigns, created } = importHarness((code) =>
      code === 'EXPO'
        ? Promise.resolve('cmp-1')
        : Promise.reject(
            new AppError('VALIDATION_FAILED', `ไม่พบแคมเปญรหัส ${code}`),
          ),
    );

    const result = await service.run(
      {
        mode: 'commit',
        import_id: 'imp-1',
        rows: [
          { row_no: 1, name: 'ก', campaign_code: 'expo' },
          { row_no: 2, name: 'ข', campaign_code: 'EXPO' },
          { row_no: 3, name: 'ค', campaign_code: 'GHOST' },
          { row_no: 4, name: 'ง' },
        ],
      } as never,
      principal(),
    );

    expect(campaigns.resolveCode).toHaveBeenCalledTimes(2);
    expect(result.summary).toEqual({ create: 3, skip: 0, error: 1 });
    expect(result.results[2]).toMatchObject({
      rowNo: 3,
      action: 'error',
      reasons: ['campaign_code: ไม่พบแคมเปญรหัส GHOST'],
    });
    expect(created.map((row) => row.campaignId)).toEqual([
      'cmp-1',
      'cmp-1',
      null,
    ]);
  });
});
