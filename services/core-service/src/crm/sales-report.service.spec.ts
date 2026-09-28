import type { Principal } from '@request-management/share';
import {
  SalesReportService,
  resolvePeriod,
  winRate,
} from './sales-report.service';

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    userId: 'u-somchai',
    username: 'somchai',
    displayName: 'สมชาย',
    activeCompanyId: 'company-osd',
    permissions: ['crm.sales.read'],
    ledUnitIds: [],
    scopedUnitIds: [],
    isServiceAccount: false,
    ...overrides,
  } as unknown as Principal;
}

const group = (key: string | null, count: number, amount: number) => ({
  key,
  count,
  amount,
});

interface Where {
  AND: unknown[];
  stage?: string | { in: string[] };
  [field: string]: unknown;
}

/**
 * The repositories answer by which question they were asked: sale orders,
 * then the opportunity stage the `where` names.
 */
function harness(data: {
  sales?: unknown[];
  won?: unknown[];
  lost?: unknown[];
  open?: unknown[];
  lostByReason?: unknown[];
}) {
  const calls: { query: string; where: Where }[] = [];

  const saleOrders = {
    totalsByOwner: jest.fn((where: Where) => {
      calls.push({ query: 'sales', where });
      return Promise.resolve(data.sales ?? []);
    }),
  };
  const opportunities = {
    totalsByOwner: jest.fn((where: Where) => {
      const query =
        where.stage === 'won'
          ? 'won'
          : where.stage === 'lost'
            ? 'lost'
            : 'open';
      calls.push({ query, where });
      return Promise.resolve(data[query] ?? []);
    }),
    totalsByLostReason: jest.fn((where: Where) => {
      calls.push({ query: 'lostByReason', where });
      return Promise.resolve(data.lostByReason ?? []);
    }),
  };
  const lostReasons = {
    findMany: jest.fn(() =>
      Promise.resolve([{ code: 'PRICE', name: 'ราคาสูงกว่าคู่แข่ง' }]),
    ),
  };
  const members = {
    findMany: jest.fn(() =>
      Promise.resolve([
        { id: 'u-somchai', displayName: 'สมชาย' },
        { id: 'u-somsri', displayName: 'สมศรี' },
      ]),
    ),
  };

  const service = new SalesReportService(
    opportunities as never,
    saleOrders as never,
    lostReasons as never,
    members as never,
  );
  const call = (query: string) => calls.find((c) => c.query === query)!;
  return { service, calls, call };
}

describe('CD-83 resolvePeriod', () => {
  // 2026-09-28 01:30 Bangkok = 2026-09-27 18:30 UTC.
  const now = new Date('2026-09-27T18:30:00Z');

  it('defaults to the Bangkok month so far', () => {
    const period = resolvePeriod({}, now);
    expect(period.from).toBe('2026-09-01');
    expect(period.to).toBe('2026-09-28');
    expect(period.start.toISOString()).toBe('2026-08-31T17:00:00.000Z');
    expect(period.end.toISOString()).toBe('2026-09-28T17:00:00.000Z');
  });

  it('treats `to` as inclusive of the whole Bangkok day', () => {
    const period = resolvePeriod({ from: '2026-09-01', to: '2026-09-30' });
    expect(period.end.toISOString()).toBe('2026-09-30T17:00:00.000Z');
  });

  it('rejects a calendar date that does not exist', () => {
    expect(() =>
      resolvePeriod({ from: '2026-02-31', to: '2026-03-05' }),
    ).toThrow('วันที่ไม่ถูกต้อง');
  });

  it('rejects from after to', () => {
    expect(() =>
      resolvePeriod({ from: '2026-09-10', to: '2026-09-01' }),
    ).toThrow('วันเริ่มต้องไม่เกินวันสิ้นสุด');
  });

  it('rejects a range over a year', () => {
    expect(() =>
      resolvePeriod({ from: '2025-01-01', to: '2026-09-01' }),
    ).toThrow('ไม่เกิน 1 ปี');
  });
});

describe('CD-83 winRate', () => {
  it('is null when nothing closed, not 0%', () => {
    expect(winRate(0, 0)).toBeNull();
  });

  it('rounds to one decimal', () => {
    expect(winRate(1, 2)).toBe(33.3);
    expect(winRate(3, 0)).toBe(100);
  });
});

describe('CD-83 SalesReportService', () => {
  const query = { from: '2026-09-01', to: '2026-09-30' };

  it('CD-83: totals, per-person figures and win rate from the grouped rows', async () => {
    const { service } = harness({
      sales: [group('u-somchai', 2, 150_000), group('u-somsri', 1, 400_000)],
      won: [group('u-somchai', 2, 150_000), group('u-somsri', 1, 400_000)],
      lost: [group('u-somchai', 2, 90_000)],
      open: [group('u-somsri', 4, 1_000_000)],
    });

    const report = await service.report(query, principal());

    expect(report.period).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(report.totals).toEqual({
      sales_amount: 550_000,
      sale_order_count: 3,
      won_count: 3,
      won_amount: 550_000,
      lost_count: 2,
      lost_amount: 90_000,
      win_rate: 60,
      open_count: 4,
      open_amount: 1_000_000,
    });

    // Highest sales first.
    expect(report.by_owner.map((row) => row.owner_name)).toEqual([
      'สมศรี',
      'สมชาย',
    ]);
    expect(report.by_owner[1]).toMatchObject({
      owner_user_id: 'u-somchai',
      won_count: 2,
      lost_count: 2,
      win_rate: 50,
      open_count: 0,
    });
    expect(report.by_owner[0].win_rate).toBe(100);
  });

  it('CD-83: loss analysis names each reason, keeps unreasoned losses, most frequent first', async () => {
    const { service } = harness({
      lostByReason: [
        group(null, 1, 10_000),
        group('PRICE', 3, 300_000),
        group('RETIRED', 1, 5_000),
      ],
    });

    const report = await service.report(query, principal());

    expect(report.lost_reasons).toEqual([
      { code: 'PRICE', name: 'ราคาสูงกว่าคู่แข่ง', count: 3, amount: 300_000 },
      { code: null, name: 'ไม่ระบุเหตุผล', count: 1, amount: 10_000 },
      // A reason since removed from the list still shows, by its code.
      { code: 'RETIRED', name: 'RETIRED', count: 1, amount: 5_000 },
    ]);
  });

  it('CD-83: an empty period answers zeros and a null win rate', async () => {
    const { service } = harness({});

    const report = await service.report(query, principal());

    expect(report.totals.sales_amount).toBe(0);
    expect(report.totals.win_rate).toBeNull();
    expect(report.by_owner).toEqual([]);
    expect(report.lost_reasons).toEqual([]);
  });

  it('SCOPE: every figure is limited to what the caller may see', async () => {
    const { service, calls } = harness({});

    await service.report(query, principal());

    expect(calls).toHaveLength(5);
    for (const { where } of calls) {
      const [visible] = where.AND;
      expect(visible).toEqual({
        companyId: 'company-osd',
        OR: [{ ownerUserId: 'u-somchai' }, { createdBy: 'u-somchai' }],
      });
    }
  });

  it('CD-83: counts only live sale orders in the period, and closes by their own dates', async () => {
    const { service, call } = harness({});

    await service.report(query, principal());

    const period = {
      gte: new Date('2026-08-31T17:00:00Z'),
      lt: new Date('2026-09-30T17:00:00Z'),
    };
    expect(call('sales').where).toMatchObject({
      status: 'open',
      orderedAt: period,
    });
    expect(call('won').where.wonAt).toEqual(period);
    expect(call('lost').where.lostAt).toEqual(period);
    expect(call('lostByReason').where.lostAt).toEqual(period);

    // Pipeline is a snapshot — no date filter.
    const open = call('open').where;
    expect(Object.keys(open).sort()).toEqual(['AND', 'stage']);
    expect(open.stage).toEqual({
      in: ['qualifying', 'proposing', 'negotiating'],
    });
  });

  it('CD-83: owner filter narrows inside the scope, never widens it', async () => {
    const { service, calls } = harness({});

    await service.report({ ...query, owner_user_id: 'u-somsri' }, principal());

    for (const { where } of calls) {
      expect(where.AND).toEqual([
        expect.objectContaining({ companyId: 'company-osd' }),
        { ownerUserId: 'u-somsri' },
      ]);
    }
  });
});
