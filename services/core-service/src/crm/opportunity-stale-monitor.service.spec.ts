import { OpportunityStaleMonitorService } from './opportunity-stale-monitor.service';

const NOW = new Date('2026-09-18T00:00:00Z');

function harness(
  options: {
    candidates?: Record<string, unknown>[];
    configs?: { companyId: string; staleOpportunityDays: number }[];
    ancestors?: string[];
    heads?: string[];
  } = {},
) {
  const stamped: { id: string; staleAlertedAt: Date }[] = [];
  const notified: { userId: string; days: number }[] = [];
  const audits: { eventType: string; after: unknown }[] = [];

  const opportunities = {
    findMany: jest.fn(() =>
      Promise.resolve(
        options.candidates ?? [
          {
            id: 'opp-1',
            companyId: 'osd',
            opportunityCode: 'OPP-OSD-000001',
            title: 'ระบบโทรศัพท์',
            ownerUserId: 'sales-1',
            ownerOrgUnitId: 'team-a',
          },
        ],
      ),
    ),
    update: jest.fn(
      (args: { where: { id: string }; data: { staleAlertedAt: Date } }) => {
        stamped.push({
          id: args.where.id,
          staleAlertedAt: args.data.staleAlertedAt,
        });
        return Promise.resolve({});
      },
    ),
  };
  const configs = {
    findMany: jest.fn(() => Promise.resolve(options.configs ?? [])),
  };
  const orgUnits = {
    ancestorIdsOf: jest.fn(() =>
      Promise.resolve(options.ancestors ?? ['team-a', 'dept-sales']),
    ),
    managersOf: jest.fn(() => Promise.resolve(options.heads ?? ['boss-1'])),
  };
  const notifications = {
    opportunityStale: jest.fn(
      (userId: string, _c: string, _o: unknown, days: number) => {
        notified.push({ userId, days });
        return Promise.resolve();
      },
    ),
  };
  const audit = {
    record: jest.fn((entry: { eventType: string; after: unknown }) => {
      audits.push(entry);
      return Promise.resolve();
    }),
  };
  const config = { get: jest.fn(() => 0) };

  const service = new OpportunityStaleMonitorService(
    opportunities as never,
    configs as never,
    orgUnits as never,
    notifications as never,
    audit as never,
    config as never,
  );

  return { service, opportunities, stamped, notified, audits };
}

type Where = {
  stage: { in: string[] };
  staleAlertedAt: null;
  AND: { OR: Record<string, unknown>[] }[];
};

function whereOf(findMany: jest.Mock): Where {
  return (findMany.mock.calls[0] as unknown as [{ where: Where }])[0].where;
}

describe('CD-65 ดีลเงียบเกินกำหนดถูกแจ้งเตือนไปยังหัวหน้า', () => {
  it('CD-65 alerts the owner and their head once, and stamps staleAlertedAt', async () => {
    const { service, stamped, notified, audits } = harness();

    const result = await service.sweep(NOW);

    expect(result).toEqual({ alerted: 1 });
    expect(stamped).toEqual([{ id: 'opp-1', staleAlertedAt: NOW }]);
    expect(notified).toEqual([
      { userId: 'sales-1', days: 14 },
      { userId: 'boss-1', days: 14 },
    ]);
    expect(audits[0].eventType).toBe('crm.opportunity.stale_alerted');
  });

  it('CD-65 only open, not-yet-alerted opportunities are candidates', async () => {
    const { service, opportunities } = harness({ candidates: [] });

    await service.sweep(NOW);

    const where = whereOf(opportunities.findMany);
    expect(where.stage.in).toEqual(['qualifying', 'proposing', 'negotiating']);
    expect(where.staleAlertedAt).toBeNull();
  });

  it('CD-65 the default threshold is 14 days, counted from creation when nothing was ever logged', async () => {
    const { service, opportunities } = harness({ candidates: [] });

    await service.sweep(NOW);

    const [defaultBranch] = whereOf(opportunities.findMany).AND[0].OR;
    const cutoff = new Date('2026-09-04T00:00:00Z');
    expect(defaultBranch).toEqual({
      companyId: { notIn: [] },
      OR: [
        { lastActivityAt: { lt: cutoff } },
        { lastActivityAt: null, createdAt: { lt: cutoff } },
      ],
    });
  });

  it('CD-65 a company threshold overrides the default and 0 switches alerts off', async () => {
    const { service, opportunities } = harness({
      candidates: [],
      configs: [
        { companyId: 'osd', staleOpportunityDays: 7 },
        { companyId: 'bco', staleOpportunityDays: 0 },
      ],
    });

    await service.sweep(NOW);

    const branches = whereOf(opportunities.findMany).AND[0].OR;
    expect(branches).toHaveLength(2);
    expect(branches[0]).toMatchObject({ companyId: 'osd' });
    expect(branches[0].OR).toContainEqual({
      lastActivityAt: { lt: new Date('2026-09-11T00:00:00Z') },
    });
    // bco is excluded from the default branch too — off means off.
    expect(branches[1]).toMatchObject({
      companyId: { notIn: ['osd', 'bco'] },
    });
  });

  it('CD-65 an owner who heads their own team escalates to the next head up', async () => {
    const { service, notified } = harness({ heads: ['sales-1', 'director-1'] });

    await service.sweep(NOW);

    expect(notified.map((n) => n.userId)).toEqual(['sales-1', 'director-1']);
  });

  it('CD-65 with no org unit or no head above, only the owner is told', async () => {
    const { service, notified } = harness({
      candidates: [
        {
          id: 'opp-2',
          companyId: 'osd',
          opportunityCode: 'OPP-OSD-000002',
          title: 'x',
          ownerUserId: 'sales-2',
          ownerOrgUnitId: null,
        },
      ],
    });

    await service.sweep(NOW);

    expect(notified.map((n) => n.userId)).toEqual(['sales-2']);
  });
});
