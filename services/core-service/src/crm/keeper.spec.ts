import type { Principal } from '@request-management/share';
import { NotificationRulesService } from '../notifications/notification-rules.service';
import { AccountReviewReminderService } from './account-review-reminder.service';
import {
  assessHealth,
  nextReviewAfter,
  type HealthInput,
} from './keeper-rules';
import { KeeperService } from './keeper.service';

const NOW = new Date('2026-09-29T03:00:00Z'); // 29 Sep 2026, Bangkok
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

function principal(
  permissions: string[] = [
    'crm.customer.read',
    'crm.customer.manage',
    'crm.sales.read',
    'request.read',
    'crm.customer.financial.read',
  ],
): Principal {
  return {
    userId: 'keeper-1',
    username: 'keeper',
    displayName: 'คีปเปอร์',
    activeCompanyId: 'osd',
    orgUnitId: 'unit-keeper',
    ledUnitIds: [],
    scopedUnitIds: [],
    permissions,
  } as unknown as Principal;
}

const calm: HealthInput = {
  cases: { breached: 0, serious: 0 },
  invoiceOverdue: null,
  contracts: { endingInDays: null, renewalOpen: false, renewalLost: false },
  satisfaction: null,
  lastContactAt: day('2026-09-20'),
  since: day('2025-01-01'),
};

describe('CD-86 health rules', () => {
  const config = { noContactDays: 60 };

  it('CD-86 no signal = green', () => {
    expect(assessHealth(calm, config, NOW)).toEqual({
      level: 'green',
      signals: [],
    });
  });

  it('CD-86 the worst signal wins, and every reason is listed', () => {
    const result = assessHealth(
      {
        ...calm,
        cases: { breached: 1, serious: 2 },
        satisfaction: 3,
        contracts: { endingInDays: 20, renewalOpen: false, renewalLost: false },
      },
      config,
      NOW,
    );
    expect(result.level).toBe('red');
    expect(result.signals.map((s) => [s.code, s.level])).toEqual([
      ['case_breached', 'red'],
      ['contract_ending', 'amber'],
      ['low_satisfaction', 'amber'],
    ]);
  });

  it('serious cases within time, a recent 1-day overdue, satisfaction 3 = amber; 30+ days overdue or 2/5 = red', () => {
    expect(
      assessHealth({ ...calm, cases: { breached: 0, serious: 1 } }, config, NOW)
        .level,
    ).toBe('amber');
    expect(
      assessHealth({ ...calm, invoiceOverdue: { maxStep: 1 } }, config, NOW)
        .level,
    ).toBe('amber');
    expect(
      assessHealth({ ...calm, invoiceOverdue: { maxStep: 30 } }, config, NOW)
        .level,
    ).toBe('red');
    expect(assessHealth({ ...calm, satisfaction: 2 }, config, NOW).level).toBe(
      'red',
    );
    expect(assessHealth({ ...calm, satisfaction: 4 }, config, NOW).level).toBe(
      'green',
    );
  });

  it('an ending contract with its renewal deal open is fine; the renewal lost is red', () => {
    expect(
      assessHealth(
        {
          ...calm,
          contracts: {
            endingInDays: 10,
            renewalOpen: true,
            renewalLost: false,
          },
        },
        config,
        NOW,
      ).level,
    ).toBe('green');
    expect(
      assessHealth(
        {
          ...calm,
          contracts: {
            endingInDays: 10,
            renewalOpen: false,
            renewalLost: true,
          },
        },
        config,
        NOW,
      ).signals[0],
    ).toMatchObject({ code: 'renewal_lost', level: 'red' });
  });

  it('CD-86 no contact: amber past the days, red past twice; never contacted counts from creation; 0 = off', () => {
    expect(
      assessHealth({ ...calm, lastContactAt: day('2026-07-15') }, config, NOW)
        .signals[0],
    ).toMatchObject({
      code: 'no_contact',
      level: 'amber',
      values: { days: 76 },
    });
    expect(
      assessHealth({ ...calm, lastContactAt: day('2026-05-20') }, config, NOW)
        .level,
    ).toBe('red');
    expect(
      assessHealth(
        { ...calm, lastContactAt: null, since: day('2026-09-01') },
        config,
        NOW,
      ).level,
    ).toBe('green');
    expect(
      assessHealth({ ...calm, lastContactAt: null }, { noContactDays: 0 }, NOW)
        .level,
    ).toBe('green');
  });

  it('signals the viewer may not see are not assessed (null), not counted as fine or bad', () => {
    expect(
      assessHealth({ ...calm, cases: null, invoiceOverdue: null }, config, NOW),
    ).toEqual({ level: 'green', signals: [] });
  });

  it('CD-86 the next review is N months on, clamped to the month end', () => {
    expect(nextReviewAfter(day('2026-09-29'), 3)).toEqual(day('2026-12-29'));
    expect(nextReviewAfter(day('2026-01-31'), 1)).toEqual(day('2026-02-28'));
    expect(nextReviewAfter(day('2026-11-30'), 3)).toEqual(day('2027-02-28'));
  });
});

describe('CD-86 KeeperService', () => {
  const customer = (overrides: Record<string, unknown> = {}) => ({
    id: 'cus-1',
    customerCode: 'CUS-OSD-1',
    nameTh: 'บริษัท ลูกค้าเดิม จำกัด',
    branchName: null,
    status: 'active',
    createdAt: day('2024-01-01'),
    accountOwner: { id: 'keeper-1', displayName: 'คีปเปอร์' },
    accountPlan: {
      tier: 'a',
      goals: 'ขยายสาขา',
      targetRevenue: 1_000_000,
      reviewEveryMonths: 3,
      nextReviewOn: day('2026-10-02'),
      updatedAt: day('2026-09-01'),
    },
    ...overrides,
  });

  function harness(
    options: {
      customers?: Record<string, unknown>[];
      deals?: Record<string, unknown>[];
      requests?: Record<string, unknown>[];
      touches?: Record<string, unknown>[];
      alerts?: Record<string, unknown>[];
      contracts?: Record<string, unknown>[];
    } = {},
  ) {
    const customers = options.customers ?? [customer()];
    const repos = {
      customers: {
        findMany: jest.fn(() => Promise.resolve(customers)),
        findFirst: jest.fn(() => Promise.resolve(customers[0] ?? null)),
      },
      plans: {
        findFirst: jest.fn(() => Promise.resolve(null)),
        upsert: jest.fn((args: unknown) => Promise.resolve(args)),
      },
      touchpoints: {
        findMany: jest.fn(() => Promise.resolve(options.touches ?? [])),
        create: jest.fn(() => Promise.resolve({ id: 'tp-1' })),
      },
      opportunities: {
        findMany: jest.fn(() => Promise.resolve(options.deals ?? [])),
      },
      quotations: { findMany: jest.fn(() => Promise.resolve([])) },
      saleOrders: {
        findMany: jest.fn(() =>
          Promise.resolve([{ customerId: 'cus-1', amount: 250000 }]),
        ),
      },
      contracts: {
        findMany: jest.fn(() => Promise.resolve(options.contracts ?? [])),
      },
      alerts: {
        findMany: jest.fn(() => Promise.resolve(options.alerts ?? [])),
      },
      requests: {
        findMany: jest.fn(() => Promise.resolve(options.requests ?? [])),
      },
      configs: {
        findFirst: jest.fn(() => Promise.resolve({ healthNoContactDays: 60 })),
      },
      members: { findMany: jest.fn(() => Promise.resolve([])) },
      timeline: { publish: jest.fn(() => Promise.resolve()) },
      audit: { record: jest.fn(() => Promise.resolve()) },
    };
    const service = new KeeperService(
      repos.customers as never,
      repos.plans as never,
      repos.touchpoints as never,
      repos.opportunities as never,
      repos.quotations as never,
      repos.saleOrders as never,
      repos.contracts as never,
      repos.alerts as never,
      repos.requests as never,
      repos.configs as never,
      repos.members as never,
      repos.timeline as never,
      repos.audit as never,
    );
    return { service, ...repos };
  }

  it('CD-86 a case raised against one of the customer’s deals counts for the customer; breached = red', async () => {
    const h = harness({
      deals: [
        {
          id: 'opp-1',
          opportunityCode: 'OPP-1',
          customerId: 'cus-1',
          stage: 'won',
          dealType: 'new_business',
          amount: null,
          lastActivityAt: day('2026-09-25'),
        },
      ],
      requests: [
        {
          refType: 'opportunity',
          refId: 'OPP-1',
          severity: 'high',
          slaClock: { breachedAt: day('2026-09-28'), responseBreachedAt: null },
        },
      ],
    });
    const page = await h.service.portfolio({}, principal(), NOW);
    expect(page.rows[0].health).toMatchObject({
      level: 'red',
      signals: [{ code: 'case_breached', values: { count: 1 } }],
    });
    // the deal's activity is the latest contact
    expect(page.rows[0].last_contact_at).toEqual(day('2026-09-25'));
    expect(page.rows[0].revenue_12m).toBe(250000);
  });

  it('CD-86 an account with open deals but none of them upsell/cross-sell is counted as no expansion', async () => {
    const h = harness({
      deals: [
        {
          id: 'opp-2',
          opportunityCode: 'OPP-2',
          customerId: 'cus-1',
          stage: 'proposing',
          dealType: 'renewal',
          amount: 100000,
          lastActivityAt: null,
        },
      ],
    });
    // the visibility query returns the same deal
    h.opportunities.findMany
      .mockImplementationOnce(() =>
        Promise.resolve([
          {
            id: 'opp-2',
            opportunityCode: 'OPP-2',
            customerId: 'cus-1',
            stage: 'proposing',
            dealType: 'renewal',
            amount: 100000,
            lastActivityAt: null,
          },
        ]),
      )
      .mockImplementationOnce(() => Promise.resolve([{ id: 'opp-2' }]));
    const page = await h.service.portfolio({}, principal(), NOW);
    expect(page.rows[0].open_deals).toEqual({
      count: 1,
      amount: 100000,
      expansion: 0,
    });
    expect(page.summary.no_expansion).toBe(1);
    expect(page.summary.reviews_due).toBe(1); // 2 Oct, within 7 days
  });

  it('without crm.sales.read / request.read / financial.read those signals and figures are left out, not guessed', async () => {
    const h = harness();
    const page = await h.service.portfolio(
      {},
      principal(['crm.customer.read']),
      NOW,
    );
    expect(page.rows[0].open_deals).toBeNull();
    expect(page.rows[0].revenue_12m).toBeNull();
    expect(h.requests.findMany).not.toHaveBeenCalled();
    expect(h.alerts.findMany).not.toHaveBeenCalled();
    expect(h.saleOrders.findMany).not.toHaveBeenCalled();
  });

  it('the latest review’s rating feeds health; health and tier filters and ordering apply', async () => {
    const h = harness({
      customers: [
        customer(),
        customer({
          id: 'cus-2',
          nameTh: 'ข',
          accountPlan: null,
        }),
      ],
      touches: [
        {
          customerId: 'cus-1',
          type: 'review',
          occurredAt: day('2026-09-20'),
          satisfaction: 2,
        },
        {
          customerId: 'cus-2',
          type: 'call',
          occurredAt: day('2026-09-21'),
          satisfaction: null,
        },
      ],
    });
    const all = await h.service.portfolio({}, principal(), NOW);
    expect(all.rows.map((row) => [row.id, row.health.level])).toEqual([
      ['cus-1', 'red'],
      ['cus-2', 'green'],
    ]);
    const red = await h.service.portfolio({ health: 'red' }, principal(), NOW);
    expect(red.rows.map((row) => row.id)).toEqual(['cus-1']);

    await h.service.portfolio({ view: 'mine', tier: 'none' }, principal(), NOW);
    const where = (
      h.customers.findMany.mock.calls.at(-1) as unknown as [
        { where: { AND: Record<string, unknown>[] } },
      ]
    )[0].where;
    expect(where.AND).toEqual(
      expect.arrayContaining([
        { accountOwnerUserId: 'keeper-1' },
        { accountPlan: { is: null } },
      ]),
    );
  });

  it('CD-86 a review moves the next review one cycle on from its day; satisfaction only on a review', async () => {
    const h = harness();
    const done = await h.service.addTouchpoint(
      'cus-1',
      {
        type: 'review',
        summary: 'ทบทวนไตรมาส',
        satisfaction: 4,
        occurred_at: '2026-09-29T03:00:00Z',
      },
      principal(),
    );
    expect(done.next_review_on).toEqual(day('2026-12-29'));
    expect(h.plans.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { nextReviewOn: day('2026-12-29'), updatedBy: 'keeper-1' },
      }),
    );
    expect(h.timeline.publish).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'customer.reviewed' }),
    );

    await expect(
      h.service.addTouchpoint(
        'cus-1',
        { type: 'call', summary: 'x', satisfaction: 5 },
        principal(),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      h.service.addTouchpoint(
        'cus-1',
        { type: 'call', summary: 'x', occurred_at: '2099-01-01T00:00:00Z' },
        principal(),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('SCOPE-03 a customer out of reach answers 404', async () => {
    const h = harness({ customers: [] });
    await expect(h.service.account('cus-x', principal())).rejects.toMatchObject(
      { code: 'NOT_FOUND' },
    );
  });
});

describe('CD-86 review reminders', () => {
  function harness(
    plans: Record<string, unknown>[],
    options: { claimed?: number; rule?: Record<string, unknown> } = {},
  ) {
    const notices: string[] = [];
    const repo = {
      findMany: jest.fn(() => Promise.resolve(plans)),
      updateMany: jest.fn(() =>
        Promise.resolve({ count: options.claimed ?? 1 }),
      ),
    };
    const service = new AccountReviewReminderService(
      repo as never,
      new NotificationRulesService({
        notificationRule: {
          findMany: jest.fn(() =>
            Promise.resolve(
              options.rule ? [{ companyId: 'osd', ...options.rule }] : [],
            ),
          ),
        },
      } as never),
      {
        accountReviewDue: jest.fn(
          (userId: string, _c: string, _cus: unknown, on: string) => {
            notices.push(`${userId}:${on}`);
            return Promise.resolve();
          },
        ),
      } as never,
      { get: jest.fn(() => 0) } as never,
    );
    return { service, repo, notices };
  }

  const plan = (overrides: Record<string, unknown> = {}) => ({
    id: 'plan-1',
    companyId: 'osd',
    nextReviewOn: day('2026-10-03'),
    reviewRemindedOn: null,
    customer: {
      id: 'cus-1',
      customerCode: 'CUS-1',
      nameTh: 'ลูกค้า',
      accountOwnerUserId: 'keeper-1',
    },
    ...overrides,
  });

  it('CD-86 the owner is told within the standard 7 days, once per review date', async () => {
    const h = harness([plan()]);
    await expect(h.service.sweep(NOW)).resolves.toEqual({ reminded: 1 });
    expect(h.notices).toEqual(['keeper-1:2026-10-03']);
    expect(h.repo.updateMany).toHaveBeenCalledWith({
      where: { id: 'plan-1', reviewRemindedOn: null },
      data: { reviewRemindedOn: day('2026-10-03') },
    });

    const again = harness([plan({ reviewRemindedOn: day('2026-10-03') })]);
    await expect(again.service.sweep(NOW)).resolves.toEqual({ reminded: 0 });
  });

  it('a later date, the company’s own window, or the rule switched off', async () => {
    const far = harness([plan({ nextReviewOn: day('2026-10-20') })]);
    await expect(far.service.sweep(NOW)).resolves.toEqual({ reminded: 0 });

    const wide = harness([plan({ nextReviewOn: day('2026-10-20') })], {
      rule: { enabled: true, params: { warn_days: 30 } },
    });
    await expect(wide.service.sweep(NOW)).resolves.toEqual({ reminded: 1 });

    const off = harness([plan()], {
      rule: { enabled: false, params: { warn_days: 7 } },
    });
    await expect(off.service.sweep(NOW)).resolves.toEqual({ reminded: 0 });
  });

  it('an overlapping tick that claimed first wins', async () => {
    const h = harness([plan()], { claimed: 0 });
    await expect(h.service.sweep(NOW)).resolves.toEqual({ reminded: 0 });
    expect(h.notices).toEqual([]);
  });
});
