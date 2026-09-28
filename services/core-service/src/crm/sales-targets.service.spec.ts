import { Prisma } from '@prisma/client';
import { AppError } from '@request-management/share';
import type { Principal } from '@request-management/share';
import {
  SalesTargetsService,
  currentPeriod,
  percentOf,
  periodRange,
} from './sales-targets.service';
import { SalesTargetApprovalSyncService } from './sales-target-approval-sync.service';

// 2026-09-28 10:00 Bangkok → current period 2026-09.
const NOW = new Date('2026-09-28T03:00:00Z');
const D = (value: number) => new Prisma.Decimal(value);

function principal(
  permissions: string[] = ['crm.sales.read', 'crm.target.manage'],
  overrides: Record<string, unknown> = {},
): Principal {
  return {
    userId: 'u-manager',
    username: 'manager',
    displayName: 'หัวหน้า',
    activeCompanyId: 'company-osd',
    permissions,
    ledUnitIds: [],
    scopedUnitIds: [],
    isServiceAccount: false,
    ...overrides,
  } as unknown as Principal;
}

interface Options {
  existing?: Record<string, unknown> | null;
  pending?: boolean;
  typeCode?: string | null;
  requestFails?: boolean;
  listRows?: unknown[];
  soldByUser?: unknown[];
  soldByUnit?: unknown[];
  pipeline?: unknown[];
  pendingRevisions?: unknown[];
  subtrees?: Map<string, string[]>;
}

function harness(options: Options = {}) {
  const targets = {
    findFirst: jest.fn(() => Promise.resolve(options.existing ?? null)),
    findMany: jest.fn((_args: { where: Record<string, unknown> }) =>
      Promise.resolve(options.listRows ?? []),
    ),
    create: jest.fn(() => Promise.resolve({ id: 't-new' })),
    update: jest.fn(() => Promise.resolve({})),
  };
  const revisions = {
    findFirst: jest.fn(() =>
      Promise.resolve(options.pending ? { id: 'rev-pending' } : null),
    ),
    findMany: jest.fn(() => Promise.resolve(options.pendingRevisions ?? [])),
    create: jest.fn(() => Promise.resolve({ id: 'rev-new' })),
  };
  const saleOrders = {
    totalsByOwner: jest.fn(() => Promise.resolve(options.soldByUser ?? [])),
    totalsByOrgUnit: jest.fn(() => Promise.resolve(options.soldByUnit ?? [])),
  };
  const opportunities = {
    findMany: jest.fn(() => Promise.resolve(options.pipeline ?? [])),
  };
  const members = {
    findActiveByIds: jest.fn((ids: string[]) =>
      Promise.resolve(
        ids
          .filter((id) => id.startsWith('u-'))
          .map((id) => ({ id, displayName: `ชื่อ ${id}`, email: null })),
      ),
    ),
    findInUnits: jest.fn(() =>
      Promise.resolve([
        { id: 'u-teammate', displayName: 'เพื่อน', email: null },
      ]),
    ),
  };
  const orgUnits = {
    findFirst: jest.fn(() => Promise.resolve({ name: 'ฝ่ายขาย' })),
    findMany: jest.fn(() =>
      Promise.resolve([{ id: 'ou-sales', name: 'ฝ่ายขาย' }]),
    ),
    subtreesOf: jest.fn(() =>
      Promise.resolve(options.subtrees ?? new Map<string, string[]>()),
    ),
  };
  const configs = {
    findFirst: jest.fn(() =>
      Promise.resolve({
        targetApprovalTypeCode:
          options.typeCode === undefined ? 'TGT' : options.typeCode,
      }),
    ),
  };
  const requestsService = {
    create: jest.fn(() =>
      options.requestFails
        ? Promise.reject(new AppError('VALIDATION_FAILED', 'type closed'))
        : Promise.resolve({ id: 'req-1' }),
    ),
  };
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const transactions = {
    execute: jest.fn((work: (prisma: unknown) => Promise<unknown>) => work({})),
  };

  const service = new SalesTargetsService(
    targets as never,
    revisions as never,
    saleOrders as never,
    opportunities as never,
    members as never,
    orgUnits as never,
    configs as never,
    requestsService as never,
    audit as never,
    transactions as never,
  );
  return { service, targets, revisions, requestsService, audit, members };
}

/** First argument of a mock's first call — for `toMatchObject` on nested shapes. */
const argOf = (mock: jest.Mock): Record<string, unknown> =>
  (mock.mock.calls[0] as [Record<string, unknown>])[0];

const setDto = (overrides: Record<string, unknown> = {}) => ({
  scope: 'user' as const,
  subject_id: 'u-somchai',
  period: '2026-09',
  amount: 1_000_000,
  ...overrides,
});

describe('CD-82 period helpers', () => {
  it('current period is the Bangkok month', () => {
    // 2026-09-30 18:00 UTC = 2026-10-01 01:00 Bangkok
    expect(currentPeriod(new Date('2026-09-30T18:00:00Z'))).toBe('2026-10');
    expect(currentPeriod(NOW)).toBe('2026-09');
  });

  it('a month runs from Bangkok midnight on the 1st, December rolls the year', () => {
    expect(periodRange('2026-09')).toEqual({
      start: new Date('2026-08-31T17:00:00Z'),
      end: new Date('2026-09-30T17:00:00Z'),
    });
    expect(periodRange('2026-12').end).toEqual(
      new Date('2026-12-31T17:00:00Z'),
    );
  });

  it('percent is null without a target, one decimal otherwise', () => {
    expect(percentOf(100, 0)).toBeNull();
    expect(percentOf(1, 3)).toBe(33.3);
  });
});

describe('CD-82 SalesTargetsService.set', () => {
  it('CD-82: first target of a period applies at once, even mid-month, with a revision and audit', async () => {
    const { service, targets, revisions, requestsService, audit } = harness();

    const result = await service.set(setDto(), principal(), NOW);

    expect(result).toEqual({
      target_id: 't-new',
      applied: true,
      approval_request_id: null,
    });
    expect(targets.create).toHaveBeenCalled();
    expect(argOf(revisions.create)).toMatchObject({
      data: {
        previousAmount: null,
        status: 'applied',
      },
    });
    expect(requestsService.create).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'crm.sales_target.set' }),
      expect.anything(),
    );
  });

  it('CD-82: changing a future month applies at once and keeps the old value', async () => {
    const { service, targets, revisions, requestsService } = harness({
      existing: { id: 't-1', amount: D(800_000) },
    });

    const result = await service.set(
      setDto({ period: '2026-10' }),
      principal(),
      NOW,
    );

    expect(result.applied).toBe(true);
    expect(targets.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 't-1' } }),
      expect.anything(),
    );
    expect(argOf(revisions.create)).toMatchObject({
      data: {
        previousAmount: D(800_000),
        status: 'applied',
      },
    });
    expect(requestsService.create).not.toHaveBeenCalled();
  });

  it('CD-82: changing a started month drafts an approval request and leaves the target alone', async () => {
    const { service, targets, revisions, requestsService } = harness({
      existing: { id: 't-1', amount: D(800_000) },
    });

    const result = await service.set(
      setDto({ reason: 'ลูกค้ารายใหญ่เลื่อนสัญญา' }),
      principal(),
      NOW,
    );

    expect(result).toEqual({
      target_id: 't-1',
      applied: false,
      approval_request_id: 'req-1',
    });
    expect(argOf(requestsService.create)).toMatchObject({
      type_code: 'TGT',
      ref_type: 'sales_target',
      ref_id: 't-1',
      form_data: { current_amount: 800000, new_amount: 1000000 },
    });
    expect(targets.update).not.toHaveBeenCalled();
    expect(argOf(revisions.create)).toMatchObject({
      data: {
        status: 'pending_approval',
        approvalRequestId: 'req-1',
        previousAmount: D(800_000),
      },
    });
  });

  it('CD-82: a mid-period change needs a reason', async () => {
    const { service } = harness({ existing: { id: 't-1', amount: D(1) } });
    await expect(service.set(setDto(), principal(), NOW)).rejects.toThrow(
      'ต้องระบุเหตุผล',
    );
  });

  it('CD-82: no request type configured → CRM_TARGET_APPROVAL_UNAVAILABLE, nothing written', async () => {
    const { service, revisions } = harness({
      existing: { id: 't-1', amount: D(1) },
      typeCode: null,
    });
    await expect(
      service.set(setDto({ reason: 'x' }), principal(), NOW),
    ).rejects.toMatchObject({ code: 'CRM_TARGET_APPROVAL_UNAVAILABLE' });
    expect(revisions.create).not.toHaveBeenCalled();
  });

  it('CD-82: a request type closed to the company → CRM_TARGET_APPROVAL_UNAVAILABLE', async () => {
    const { service, revisions } = harness({
      existing: { id: 't-1', amount: D(1) },
      requestFails: true,
    });
    await expect(
      service.set(setDto({ reason: 'x' }), principal(), NOW),
    ).rejects.toMatchObject({ code: 'CRM_TARGET_APPROVAL_UNAVAILABLE' });
    expect(revisions.create).not.toHaveBeenCalled();
  });

  it('CD-82: one adjustment waiting at a time', async () => {
    const { service, requestsService } = harness({
      existing: { id: 't-1', amount: D(1) },
      pending: true,
    });
    await expect(
      service.set(setDto({ reason: 'x' }), principal(), NOW),
    ).rejects.toMatchObject({ code: 'CRM_TARGET_ADJUSTMENT_PENDING' });
    expect(requestsService.create).not.toHaveBeenCalled();
  });

  it('CD-82: the same amount again is refused, not recorded', async () => {
    const { service, revisions } = harness({
      existing: { id: 't-1', amount: D(1_000_000) },
    });
    await expect(service.set(setDto(), principal(), NOW)).rejects.toThrow(
      'เท่ากับเป้าเดิม',
    );
    expect(revisions.create).not.toHaveBeenCalled();
  });

  it('SCOPE-03: a subject outside the company is refused', async () => {
    const { service, targets } = harness();
    await expect(
      service.set(setDto({ subject_id: 'someone-else' }), principal(), NOW),
    ).rejects.toThrow('ไม่พบพนักงานหรือกลุ่มนี้ในบริษัท');
    expect(targets.create).not.toHaveBeenCalled();
  });
});

describe('CD-82 SalesTargetsService.list', () => {
  it('CD-82: actual, weighted forecast and % per person; org unit sums its subtree', async () => {
    const { service } = harness({
      listRows: [
        {
          id: 't-user',
          scope: 'user',
          subjectId: 'u-somchai',
          period: '2026-09',
          amount: D(1_000_000),
        },
        {
          id: 't-unit',
          scope: 'org_unit',
          subjectId: 'ou-sales',
          period: '2026-09',
          amount: D(2_000_000),
        },
      ],
      soldByUser: [{ key: 'u-somchai', count: 2, amount: 400_000 }],
      soldByUnit: [
        { key: 'ou-sales', count: 1, amount: 100_000 },
        { key: 'ou-team-a', count: 3, amount: 500_000 },
        { key: 'ou-elsewhere', count: 9, amount: 9_000_000 },
      ],
      subtrees: new Map([['ou-sales', ['ou-sales', 'ou-team-a']]]),
      pipeline: [
        // 50% of 600k, closing this month
        {
          ownerUserId: 'u-somchai',
          ownerOrgUnitId: 'ou-team-a',
          amount: D(600_000),
          probability: 50,
        },
        {
          ownerUserId: 'u-other',
          ownerOrgUnitId: 'ou-elsewhere',
          amount: D(1_000_000),
          probability: 90,
        },
      ],
      pendingRevisions: [
        {
          id: 'rev-1',
          targetId: 't-user',
          newAmount: D(1_200_000),
          approvalRequestId: 'req-9',
        },
      ],
    });

    const result = await service.list({ period: '2026-09' }, principal(), NOW);

    expect(result).toMatchObject({
      period: '2026-09',
      started: true,
      closed: false,
      can_manage: true,
      adjustment_configured: true,
    });
    // org units first
    expect(result.targets.map((t) => t.id)).toEqual(['t-unit', 't-user']);
    expect(result.targets[1]).toMatchObject({
      subject_name: 'ชื่อ u-somchai',
      amount: 1_000_000,
      actual: 400_000,
      forecast: 700_000,
      attainment_pct: 40,
      forecast_pct: 70,
      pending: {
        revision_id: 'rev-1',
        new_amount: 1_200_000,
        approval_request_id: 'req-9',
      },
    });
    expect(result.targets[0]).toMatchObject({
      subject_name: 'ฝ่ายขาย',
      actual: 600_000,
      forecast: 900_000,
      attainment_pct: 30,
      pending: null,
    });
  });

  it('CD-82: a closed month forecasts what was sold — the pipeline is not asked', async () => {
    const { service } = harness({
      listRows: [
        {
          id: 't-user',
          scope: 'user',
          subjectId: 'u-somchai',
          period: '2026-08',
          amount: D(500_000),
        },
      ],
      soldByUser: [{ key: 'u-somchai', count: 1, amount: 250_000 }],
      pipeline: [
        {
          ownerUserId: 'u-somchai',
          ownerOrgUnitId: null,
          amount: D(999_999),
          probability: 100,
        },
      ],
    });

    const result = await service.list({ period: '2026-08' }, principal(), NOW);

    expect(result.closed).toBe(true);
    expect(result.targets[0].forecast).toBe(250_000);
  });

  it('SCOPE: a target setter sees the whole company', async () => {
    const { service, targets } = harness();
    await service.list({}, principal(), NOW);
    expect(targets.findMany.mock.calls[0][0].where).toEqual({
      companyId: 'company-osd',
      period: '2026-09',
    });
  });

  it('SCOPE: an employee sees own target, the team they lead, and its people', async () => {
    const { service, targets } = harness();
    await service.list(
      {},
      principal(['crm.sales.read'], {
        userId: 'u-lead',
        ledUnitIds: ['ou-team-a'],
      }),
      NOW,
    );
    expect(targets.findMany.mock.calls[0][0].where).toEqual({
      companyId: 'company-osd',
      period: '2026-09',
      OR: [
        { scope: 'user', subjectId: { in: ['u-lead', 'u-teammate'] } },
        { scope: 'org_unit', subjectId: { in: ['ou-team-a'] } },
      ],
    });
  });

  it('SCOPE: someone with no team sees only their own', async () => {
    const { service, targets, members } = harness();
    await service.list(
      {},
      principal(['crm.sales.read'], { userId: 'u-somchai' }),
      NOW,
    );
    expect(members.findInUnits).not.toHaveBeenCalled();
    expect(targets.findMany.mock.calls[0][0].where).toMatchObject({
      OR: [{ scope: 'user', subjectId: { in: ['u-somchai'] } }],
    });
  });
});

describe('CD-82 SalesTargetApprovalSyncService', () => {
  function sync(found: unknown, moved = 1) {
    const revisions = { findFirst: jest.fn(() => Promise.resolve(found)) };
    const prisma = {
      salesTargetRevision: {
        updateMany: jest.fn(() => Promise.resolve({ count: moved })),
      },
      salesTarget: { update: jest.fn(() => Promise.resolve({})) },
    };
    const audit = { record: jest.fn(() => Promise.resolve()) };
    const transactions = {
      execute: jest.fn((work: (p: unknown) => Promise<unknown>) =>
        work(prisma),
      ),
    };
    const service = new SalesTargetApprovalSyncService(
      { on: jest.fn() } as never,
      revisions as never,
      audit as never,
      transactions as never,
    );
    return { service, prisma, audit };
  }

  const pending = {
    id: 'rev-1',
    companyId: 'company-osd',
    targetId: 't-1',
    previousAmount: D(800_000),
    newAmount: D(1_000_000),
  };
  const payload = { request_id: 'req-1', request_no: 'REQ-1' } as never;

  it('CD-82: approved → the new amount takes effect and the revision is applied', async () => {
    const { service, prisma, audit } = sync(pending);

    await service.onRequestOutcome(payload, 'approved');

    expect(argOf(prisma.salesTargetRevision.updateMany)).toMatchObject({
      where: { id: 'rev-1', status: 'pending_approval' },
      data: { status: 'applied' },
    });
    expect(argOf(prisma.salesTarget.update)).toMatchObject({
      where: { id: 't-1' },
      data: { amount: D(1_000_000) },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'crm.sales_target.adjustment_approved',
      }),
      expect.anything(),
    );
  });

  it('CD-82: rejected → the target keeps its value', async () => {
    const { service, prisma } = sync(pending);

    await service.onRequestOutcome(payload, 'rejected');

    expect(argOf(prisma.salesTargetRevision.updateMany)).toMatchObject({
      data: { status: 'rejected' },
    });
    expect(prisma.salesTarget.update).not.toHaveBeenCalled();
  });

  it('CD-82: a request that is not a target adjustment is ignored', async () => {
    const { service, prisma } = sync(null);
    await service.onRequestOutcome(payload, 'approved');
    expect(prisma.salesTargetRevision.updateMany).not.toHaveBeenCalled();
  });

  it('CD-82: a redelivered event after the revision moved changes nothing', async () => {
    const { service, prisma, audit } = sync(pending, 0);
    await service.onRequestOutcome(payload, 'approved');
    expect(prisma.salesTarget.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });
});
