import type { Principal } from '@request-management/share';
import { CrmDashboardService } from './crm-dashboard.service';

// 2026-09-28 10:00 Bangkok.
const NOW = new Date('2026-09-28T03:00:00Z');
const MONTH_START = new Date('2026-08-31T17:00:00Z');

function principal(permissions: string[] = ['crm.sales.read']): Principal {
  return {
    userId: 'u-somchai',
    username: 'somchai',
    displayName: 'สมชาย',
    activeCompanyId: 'company-osd',
    permissions,
    ledUnitIds: [],
    scopedUnitIds: [],
    isServiceAccount: false,
  } as unknown as Principal;
}

interface Where {
  AND?: unknown[];
  [field: string]: unknown;
}

function harness(
  data: {
    openOpportunities?: unknown[];
    wonGroups?: unknown[];
    leadCounts?: { status: string; count: number }[];
  } = {},
) {
  const counts: { repo: string; where: Where }[] = [];
  const counter = (repo: string, answer = 1) =>
    jest.fn(({ where }: { where: Where }) => {
      counts.push({ repo, where });
      return Promise.resolve(answer);
    });

  const customers = { count: counter('customers', 4) };
  const leads = {
    count: counter('leads', 2),
    countByStatus: jest.fn((where: Where) => {
      counts.push({ repo: 'leadsByStatus', where });
      return Promise.resolve(data.leadCounts ?? []);
    }),
  };
  const leadStatuses = {
    listAll: jest.fn(() =>
      Promise.resolve([
        {
          code: 'new',
          nameTh: 'ใหม่',
          kind: 'open',
          color: 'blue',
          active: true,
        },
        {
          code: 'contacted',
          nameTh: 'ติดต่อแล้ว',
          kind: 'open',
          color: 'cyan',
          active: true,
        },
        // ปิดใช้แล้วแต่ยังมี Lead ค้าง — ต้องยังโชว์
        {
          code: 'old',
          nameTh: 'ขั้นเก่า',
          kind: 'open',
          color: 'default',
          active: false,
        },
        // ปิดใช้แล้วและไม่มี Lead — ซ่อน
        {
          code: 'gone',
          nameTh: 'ขั้นที่เลิกใช้',
          kind: 'open',
          color: 'default',
          active: false,
        },
        {
          code: 'converted',
          nameTh: 'แปลงแล้ว',
          kind: 'won',
          color: 'green',
          active: true,
        },
        {
          code: 'dropped',
          nameTh: 'คัดออก',
          kind: 'lost',
          color: 'red',
          active: true,
        },
      ]),
    ),
  };
  const opportunities = {
    findMany: jest.fn((args: { where: Where }) => {
      counts.push({ repo: 'openOpportunities', where: args.where });
      return Promise.resolve(data.openOpportunities ?? []);
    }),
    totalsByOwner: jest.fn((where: Where) => {
      counts.push({ repo: 'won', where });
      return Promise.resolve(data.wonGroups ?? []);
    }),
  };
  const leadActivities = { count: counter('leadActivities', 1) };
  const opportunityActivities = { count: counter('opportunityActivities', 2) };

  const service = new CrmDashboardService(
    customers as never,
    leads as never,
    leadStatuses as never,
    opportunities as never,
    leadActivities as never,
    opportunityActivities as never,
  );
  return { service, counts };
}

describe('CD-73 CrmDashboardService', () => {
  it('CD-73: pipeline by stage with weighted value, stale count and this month’s wins', async () => {
    const { service } = harness({
      openOpportunities: [
        {
          stage: 'qualifying',
          amount: '100000',
          probability: 20,
          staleAlertedAt: null,
        },
        {
          stage: 'proposing',
          amount: '200000',
          probability: 50,
          staleAlertedAt: NOW,
        },
        {
          stage: 'proposing',
          amount: null,
          probability: 50,
          staleAlertedAt: null,
        },
        // ไม่มีความน่าจะเป็น = ไม่นับในยอดถ่วง แต่นับในยอดรวม
        {
          stage: 'negotiating',
          amount: '300000',
          probability: null,
          staleAlertedAt: null,
        },
      ],
      wonGroups: [
        { key: 'u-somchai', count: 2, amount: 150000 },
        { key: 'u-somsri', count: 1, amount: 50000 },
      ],
    });

    const result = await service.dashboard({}, principal(), NOW);

    expect(result.opportunities).toEqual({
      open_count: 4,
      open_amount: 600000,
      weighted_amount: 120000,
      stale_count: 1,
      won_this_month: { count: 3, amount: 200000 },
      by_stage: [
        {
          stage: 'qualifying',
          count: 1,
          amount: 100000,
          weighted_amount: 20000,
        },
        {
          stage: 'proposing',
          count: 2,
          amount: 200000,
          weighted_amount: 100000,
        },
        { stage: 'negotiating', count: 1, amount: 300000, weighted_amount: 0 },
      ],
    });
  });

  it('CD-73: leads by the company’s own open statuses, in its order', async () => {
    const { service } = harness({
      leadCounts: [
        { status: 'new', count: 5 },
        { status: 'old', count: 1 },
        { status: 'converted', count: 9 },
      ],
    });

    const result = await service.dashboard({}, principal(), NOW);

    expect(result.leads.by_status).toEqual([
      { code: 'new', name: 'ใหม่', color: 'blue', count: 5 },
      { code: 'contacted', name: 'ติดต่อแล้ว', color: 'cyan', count: 0 },
      { code: 'old', name: 'ขั้นเก่า', color: 'default', count: 1 },
    ]);
    // won/lost statuses are closed — not "open leads".
    expect(result.leads.open).toBe(6);
    expect(result.leads.new_this_month).toBe(2);
  });

  it('CD-73: customer figures are null without crm.customer.read, not zero', async () => {
    const { service, counts } = harness();

    const result = await service.dashboard({}, principal(), NOW);

    expect(result.customers).toBeNull();
    expect(counts.some((call) => call.repo === 'customers')).toBe(false);
  });

  it('CD-73: customer figures with crm.customer.read — active now, new this month', async () => {
    const { service, counts } = harness();

    const result = await service.dashboard(
      {},
      principal(['crm.sales.read', 'crm.customer.read']),
      NOW,
    );

    expect(result.customers).toEqual({ active: 4, new_this_month: 4 });
    const calls = counts.filter((call) => call.repo === 'customers');
    expect(calls.map((call) => call.where.status)).toContain('active');
    expect(calls.map((call) => call.where.createdAt)).toContainEqual({
      gte: MONTH_START,
    });
  });

  it('CD-73: activities — overdue, due in 7 days, done this month — summed across leads and opportunities', async () => {
    const { service, counts } = harness();

    const result = await service.dashboard({}, principal(), NOW);

    // each figure = 1 (lead) + 2 (opportunity)
    expect(result.activities).toEqual({
      overdue: 3,
      due_soon: 3,
      completed_this_month: 3,
    });

    const onLeads = counts.filter((call) => call.repo === 'leadActivities');
    expect(onLeads.map((call) => call.where.dueAt)).toEqual(
      expect.arrayContaining([
        { lt: NOW },
        { gte: NOW, lt: new Date('2026-10-05T03:00:00Z') },
      ]),
    );
    // scoped through the parent row, not by who wrote the activity
    for (const call of onLeads) expect(call.where).toHaveProperty('lead');
    for (const call of counts.filter(
      (entry) => entry.repo === 'opportunityActivities',
    )) {
      expect(call.where).toHaveProperty('opportunity');
    }
  });

  it('SCOPE: team view = the caller’s visibility, no owner narrowing', async () => {
    const { service, counts } = harness();

    const result = await service.dashboard({}, principal(), NOW);

    expect(result.view).toBe('team');
    expect(result.month_from).toBe('2026-09-01');
    const opportunities = counts.find(
      (call) => call.repo === 'openOpportunities',
    )!;
    expect(opportunities.where.AND).toEqual([
      {
        companyId: 'company-osd',
        OR: [{ ownerUserId: 'u-somchai' }, { createdBy: 'u-somchai' }],
      },
      {},
    ]);
  });

  it('SCOPE: mine narrows every section to rows the caller owns, inside the scope', async () => {
    const { service, counts } = harness();

    await service.dashboard(
      { view: 'mine' },
      principal(['crm.sales.read', 'crm.customer.read']),
      NOW,
    );

    for (const repo of ['openOpportunities', 'won', 'leads', 'leadsByStatus']) {
      const call = counts.find((entry) => entry.repo === repo)!;
      expect(call.where.AND).toContainEqual({ ownerUserId: 'u-somchai' });
      expect(call.where.AND![0]).toMatchObject({ companyId: 'company-osd' });
    }
    const customers = counts.find((entry) => entry.repo === 'customers')!;
    expect(customers.where.AND).toContainEqual({
      accountOwnerUserId: 'u-somchai',
    });
  });
});
