import type { Principal } from '@request-management/share';
import { KycExpiryService } from './kyc-expiry.service';
import { KycService } from './kyc.service';
import { NotificationRulesService } from '../notifications/notification-rules.service';

const NOW = new Date('2026-09-29T03:00:00Z'); // 29 Sep 2026, Bangkok

const record = (
  id: string,
  expiresOn: string,
  owner: string | null = 'owner-1',
) => ({
  id,
  companyId: 'osd',
  customerId: `cus-${id}`,
  expiresOn: new Date(`${expiresOn}T00:00:00Z`),
  customer: {
    id: `cus-${id}`,
    customerCode: `CUS-${id}`,
    nameTh: `ลูกค้า ${id}`,
    accountOwnerUserId: owner,
  },
});

function harness(options: {
  expired?: unknown[];
  expiring?: unknown[];
  claim?: number;
  /** CD-53 — the company's saved `kyc.expiry` rule, if any. */
  rule?: { enabled: boolean; params: Record<string, unknown> };
}) {
  const customerUpdates: unknown[] = [];
  const notified: string[] = [];
  const records = {
    findMany: jest.fn(
      (args: { where: { expiresOn: Record<string, unknown> } }) =>
        Promise.resolve(
          'lt' in args.where.expiresOn
            ? (options.expired ?? [])
            : (options.expiring ?? []),
        ),
    ),
    updateMany: jest.fn(() => Promise.resolve({ count: options.claim ?? 1 })),
  };
  const notifications = {
    kycExpiring: jest.fn((userId: string) => {
      notified.push(`expiring:${userId}`);
      return Promise.resolve();
    }),
    kycExpired: jest.fn((userId: string) => {
      notified.push(`expired:${userId}`);
      return Promise.resolve();
    }),
  };
  const service = new KycExpiryService(
    records as never,
    {
      update: jest.fn((args: unknown) => {
        customerUpdates.push(args);
        return Promise.resolve({});
      }),
    } as never,
    { createMany: jest.fn(() => Promise.resolve({ count: 1 })) } as never,
    { publish: jest.fn(() => Promise.resolve()) } as never,
    notifications as never,
    new NotificationRulesService({
      notificationRule: {
        findMany: jest.fn(() =>
          Promise.resolve(
            options.rule ? [{ companyId: 'osd', ...options.rule }] : [],
          ),
        ),
      },
    } as never),
    { record: jest.fn(() => Promise.resolve()) } as never,
    { get: jest.fn(() => 0) } as never,
  );
  return { service, records, customerUpdates, notified };
}

describe('CD-61 KYC expiry sweep', () => {
  it('CD-61: past its date → expired, the customer unverified, the owner told', async () => {
    const h = harness({ expired: [record('a', '2026-09-28')] });
    await expect(h.service.sweep(NOW)).resolves.toEqual({
      warned: 0,
      expired: 1,
    });
    expect(h.records.updateMany).toHaveBeenCalledWith({
      where: { id: 'a', status: 'verified' },
      data: { status: 'expired' },
    });
    expect(h.customerUpdates).toEqual([
      { where: { id: 'cus-a' }, data: { kycVerified: false } },
    ]);
    expect(h.notified).toEqual(['expired:owner-1']);
  });

  it('CD-61: within 30 days → the owner is warned once', async () => {
    const h = harness({
      expiring: [record('b', '2026-10-20'), record('c', '2026-10-25', null)],
    });
    await expect(h.service.sweep(NOW)).resolves.toEqual({
      warned: 2,
      expired: 0,
    });
    // a customer with no owner is still marked warned, nobody to tell
    expect(h.notified).toEqual(['expiring:owner-1']);
  });

  it('a record another tick already handled is left alone', async () => {
    const h = harness({
      expired: [record('a', '2026-09-28')],
      expiring: [record('b', '2026-10-20')],
      claim: 0,
    });
    await expect(h.service.sweep(NOW)).resolves.toEqual({
      warned: 0,
      expired: 0,
    });
    expect(h.customerUpdates).toHaveLength(0);
    expect(h.notified).toHaveLength(0);
  });

  it('the window is Bangkok days: today is not yet expired, 30 days out is warned', async () => {
    const h = harness({});
    await h.service.sweep(NOW);
    const [expiredQuery, warnQuery] = h.records.findMany.mock
      .calls as unknown as [{ where: { expiresOn: Record<string, Date> } }][];
    expect(expiredQuery[0].where.expiresOn).toEqual({
      lt: new Date('2026-09-29T00:00:00Z'),
    });
    expect(warnQuery[0].where.expiresOn).toEqual({
      gte: new Date('2026-09-29T00:00:00Z'),
      lte: new Date('2026-10-29T00:00:00Z'),
    });
  });

  it('CD-53: the warning window is the company rule — 60 days reads further, a later record waits', async () => {
    const rule = { enabled: true, params: { warn_days: 10 } };
    const h = harness({ expiring: [record('b', '2026-10-20')], rule });
    // 21 days out: the standard 30 would warn, this company's 10 does not
    await expect(h.service.sweep(NOW)).resolves.toEqual({
      warned: 0,
      expired: 0,
    });
    expect(h.records.updateMany).not.toHaveBeenCalled();

    const wide = harness({
      rule: { enabled: true, params: { warn_days: 60 } },
    });
    await wide.service.sweep(NOW);
    const [, warnQuery] = wide.records.findMany.mock.calls as unknown as [
      { where: { expiresOn: Record<string, Date> } },
    ][];
    expect(warnQuery[0].where.expiresOn.lte).toEqual(
      new Date('2026-11-28T00:00:00Z'),
    );
  });

  it('CD-53: rule switched off — records still expire, nobody is told', async () => {
    const rule = { enabled: false, params: { warn_days: 30 } };
    const h = harness({
      expired: [record('a', '2026-09-28')],
      expiring: [record('b', '2026-10-20')],
      rule,
    });
    await expect(h.service.sweep(NOW)).resolves.toEqual({
      warned: 0,
      expired: 1,
    });
    expect(h.notified).toEqual([]);
    // nothing claimed for the warning either — switching back on still warns
    expect(h.records.updateMany).toHaveBeenCalledTimes(1);
  });
});

describe('CD-61 the prohibited list', () => {
  const admin = {
    userId: 'admin',
    activeCompanyId: 'osd',
  } as unknown as Principal;

  function listHarness(found: Record<string, unknown> | null = null) {
    const watchlist = {
      createMany: jest.fn(() => Promise.resolve({ count: 2 })),
      findFirst: jest.fn(() => Promise.resolve(found)),
      update: jest.fn(() => Promise.resolve({})),
    };
    const audit = { record: jest.fn(() => Promise.resolve()) };
    const service = new KycService(
      {} as never,
      {} as never,
      watchlist as never,
      audit as never,
      {
        execute: jest.fn((work: (p: unknown) => unknown) => work({})),
      } as never,
    );
    return { service, watchlist, audit };
  }

  it('entries are stored with the normalized name and digits-only tax id, and audited', async () => {
    const { service, watchlist, audit } = listHarness();
    await service.addToWatchlist(
      [
        {
          name: 'บจก. ต้องห้าม',
          tax_id: '0-1055-51234-56-7',
          reason: 'คว่ำบาตร',
        },
        { name: 'อีกราย', reason: 'ทุจริต' },
      ],
      admin,
    );
    const rows = (
      watchlist.createMany.mock.calls[0] as unknown as [
        { data: Record<string, unknown>[] },
      ]
    )[0].data;
    expect(rows[0]).toMatchObject({
      companyId: 'osd',
      normalizedName: 'ต้องห้าม',
      taxId: '0105551234567',
    });
    expect(rows[1]).toMatchObject({ taxId: null });
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it('an entry without a reason is refused', async () => {
    const { service } = listHarness();
    await expect(
      service.addToWatchlist([{ name: 'x', reason: ' ' }], admin),
    ).rejects.toThrow('ต้องมีชื่อและเหตุผล');
  });

  it('removal is deactivation, audited; another company’s entry is 404', async () => {
    const mine = listHarness({ id: 'wl-1', name: 'x', active: true });
    await mine.service.deactivateWatchlistEntry('wl-1', admin);
    expect(mine.watchlist.update).toHaveBeenCalledWith(
      { where: { id: 'wl-1' }, data: { active: false, updatedBy: 'admin' } },
      { prisma: {} },
    );
    expect(mine.audit.record).toHaveBeenCalledTimes(1);

    const other = listHarness(null);
    await expect(
      other.service.deactivateWatchlistEntry('wl-9', admin),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
