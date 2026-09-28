import { Prisma } from '@prisma/client';
import type { Principal } from '@request-management/share';
import { OpportunitiesService } from './opportunities.service';

function principal(): Principal {
  return {
    userId: 'u-somchai',
    username: 'somchai',
    displayName: 'สมชาย',
    activeCompanyId: 'company-osd',
    permissions: ['crm.sales.read'],
    ledUnitIds: [],
    scopedUnitIds: [],
    isServiceAccount: false,
  } as unknown as Principal;
}

function harness(rows: unknown[]) {
  const calls: { where: Record<string, unknown> }[] = [];
  const opportunities = {
    findMany: jest.fn((args: { where: Record<string, unknown> }) => {
      calls.push(args);
      return Promise.resolve(rows);
    }),
  };
  const service = new OpportunitiesService(
    opportunities as never,
    ...(Array.from({ length: 9 }, () => ({})) as [
      never,
      never,
      never,
      never,
      never,
      never,
      never,
      never,
      never,
    ]),
  );
  return { service, calls };
}

const D = (value: number) => new Prisma.Decimal(value);

describe('CD-74 OpportunitiesService.stageSummary', () => {
  it('CD-74: count, value and probability-weighted value per stage, every stage present', async () => {
    const { service } = harness([
      { stage: 'qualifying', amount: D(100_000), probability: 20 },
      { stage: 'proposing', amount: D(200_000), probability: 50 },
      { stage: 'proposing', amount: null, probability: 90 },
      { stage: 'negotiating', amount: D(300_000), probability: null },
      { stage: 'won', amount: D(250_000), probability: 100 },
    ]);

    const summary = await service.stageSummary(principal(), {} as never);

    expect(summary).toEqual([
      {
        stage: 'qualifying',
        count: 1,
        amount: 100_000,
        weighted_amount: 20_000,
      },
      {
        stage: 'proposing',
        count: 2,
        amount: 200_000,
        weighted_amount: 100_000,
      },
      // no probability → counted in value, not in the weighted figure
      { stage: 'negotiating', count: 1, amount: 300_000, weighted_amount: 0 },
      // closed stages carry no weighting
      { stage: 'won', count: 1, amount: 250_000, weighted_amount: null },
      { stage: 'lost', count: 0, amount: 0, weighted_amount: null },
    ]);
  });

  it('SCOPE-02: the summary uses the list’s own filter — scope, mine, search — and no paging', async () => {
    const { service, calls } = harness([]);

    await service.stageSummary(principal(), {
      view: 'mine',
      search: 'ธนาคาร',
      page: 3,
      page_size: 10,
    } as never);

    const args = calls[0] as Record<string, unknown> & {
      where: { AND: Record<string, unknown>[] };
    };
    expect(args).not.toHaveProperty('skip');
    expect(args).not.toHaveProperty('take');
    expect(args.where.AND[0]).toEqual({
      companyId: 'company-osd',
      OR: [{ ownerUserId: 'u-somchai' }, { createdBy: 'u-somchai' }],
    });
    expect(args.where.AND[1]).toMatchObject({
      ownerUserId: 'u-somchai',
      OR: expect.any(Array) as unknown,
    });
  });
});
