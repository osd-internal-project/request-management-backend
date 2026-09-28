import { AppError } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { ApprovalsService } from './approvals.service';
import { AccessService, type MatrixLevel } from '../access/access.service';
import { assertValidLevels } from './matrix-rules';

const OSD = 'company-osd';

function principal(userId: string): Principal {
  return {
    userId,
    activeCompanyId: OSD,
    username: userId,
    permissions: ['approval.decide'],
    scopeGrants: [],
    // Only the fields these paths read.
  } as unknown as Principal;
}

/** Opens a case over `levels`, each level resolving to the people in `people`. */
async function openWith(
  levels: MatrixLevel[],
  people: Record<number, string[]>,
  payload: Record<string, unknown> = {},
) {
  const created: { data: Record<string, unknown> }[] = [];
  let level = 0;
  const prisma = {
    approvalCase: {
      create: jest.fn((args: { data: Record<string, unknown> }) => {
        created.push(args);
        return Promise.resolve({
          id: 'case-1',
          status: args.data.status ?? 'pending',
          currentStep: args.data.currentStep,
          steps: [],
        });
      }),
    },
  };
  const service = new ApprovalsService(
    {} as never,
    {} as never,
    {
      requireEffective: jest.fn(() =>
        Promise.resolve({ id: 'm-1', version: 1, currency: 'THB', levels }),
      ),
    } as never,
    {
      approverCandidatesOf: jest.fn(() =>
        Promise.resolve(people[level++] ?? []),
      ),
    } as never,
    { resolve: jest.fn(() => Promise.resolve({ orgUnitId: 'ou-1' })) } as never,
    { awaitingApproval: jest.fn(() => Promise.resolve()) } as never,
    { emit: jest.fn(() => Promise.resolve()) } as never,
    { record: jest.fn(() => Promise.resolve()) } as never,
    {
      execute: jest.fn((work: (client: unknown) => unknown) => work(prisma)),
    } as never,
    {} as never,
    {
      stop: jest.fn(() => Promise.resolve()),
      resume: jest.fn(() => Promise.resolve()),
      pause: jest.fn(() => Promise.resolve()),
      dueAfter: jest.fn(() => Promise.resolve(null)),
    } as never, // sla
  );

  const opened = await service.openCase(
    { subject_type: 'request:IT', subject_id: 'REQ-1', payload },
    principal('user-requester'),
    'Bearer t',
  );
  const steps = (created[0].data.steps as { create: Record<string, unknown>[] })
    .create;
  return { opened, data: created[0].data, steps };
}

describe('APV level options: which levels are asked', () => {
  it('records a level whose condition fails as skipped and starts at the next', async () => {
    const { data, steps } = await openWith(
      [
        {
          type: 'supervisor',
          up: 1,
          condition: { field: 'amount', op: 'gt', value: 1_000_000 },
        },
        { type: 'supervisor', up: 2 },
      ],
      { 0: ['user-a'], 1: ['user-b'] },
      { amount: 500 },
    );

    expect(steps.map((step) => [step.status, step.skipReason])).toEqual([
      ['skipped', 'condition'],
      ['pending', null],
    ]);
    expect(data.currentStep).toBe(2);
  });

  it('asks the same people once when two levels resolve to them', async () => {
    const { steps } = await openWith(
      [
        { type: 'supervisor', up: 1 },
        { type: 'supervisor', up: 2 },
      ],
      { 0: ['user-head'], 1: ['user-head'] },
    );

    expect(steps.map((step) => [step.status, step.skipReason])).toEqual([
      ['pending', null],
      ['skipped', 'same_approver'],
    ]);
  });

  it('opens already approved when every level is skipped, and asks nobody', async () => {
    const { opened } = await openWith(
      [
        {
          type: 'supervisor',
          up: 1,
          condition: { field: 'amount', op: 'gt', value: 10 },
        },
      ],
      { 0: ['user-a'] },
      { amount: 1 },
    );

    expect(opened.status).toBe('approved');
  });

  it('copies mode, noteRequired and slaHours onto the step', async () => {
    const { steps } = await openWith(
      [
        {
          type: 'supervisor',
          up: 1,
          mode: 'all',
          noteRequired: 'reject_or_return',
          slaHours: 8,
        },
      ],
      { 0: ['user-a', 'user-b'] },
    );

    expect(steps[0]).toMatchObject({
      mode: 'all',
      noteRequired: 'reject_or_return',
      slaHours: 8,
    });
  });
});

function deciding(step: Record<string, unknown>, approvalsSoFar: number) {
  const claims: unknown[] = [];
  const prisma = {
    approvalCase: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          id: 'case-1',
          companyId: OSD,
          status: 'pending',
          currentStep: 1,
          subjectType: 'request:IT',
          requestId: null,
          request: null,
          createdBy: 'user-requester',
          steps: [
            {
              id: 'step-1',
              stepNo: 1,
              status: 'pending',
              candidateUserIds: ['user-a', 'user-b'],
              approverUserId: 'user-a',
              mode: 'any',
              noteRequired: 'always',
              ...step,
            },
          ],
        }),
      ),
      updateMany: jest.fn((args: unknown) => {
        claims.push(args);
        return Promise.resolve({ count: 1 });
      }),
      findUniqueOrThrow: jest.fn(() =>
        Promise.resolve({ id: 'case-1', status: 'pending', steps: [] }),
      ),
    },
    approvalStep: {
      update: jest.fn(() => Promise.resolve({})),
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
    },
    approvalVote: {
      create: jest.fn(() => Promise.resolve({})),
      count: jest.fn(() => Promise.resolve(approvalsSoFar + 1)),
    },
  };
  const service = new ApprovalsService(
    {} as never,
    { findActiveFor: jest.fn(() => Promise.resolve(null)) } as never,
    {} as never,
    {} as never,
    {} as never,
    { decisionMade: jest.fn(() => Promise.resolve()) } as never,
    { emit: jest.fn(() => Promise.resolve()) } as never,
    { record: jest.fn(() => Promise.resolve()) } as never,
    {
      execute: jest.fn((work: (client: unknown) => unknown) => work(prisma)),
    } as never,
    {} as never,
    {
      stop: jest.fn(() => Promise.resolve()),
      resume: jest.fn(() => Promise.resolve()),
      pause: jest.fn(() => Promise.resolve()),
      dueAfter: jest.fn(() => Promise.resolve(null)),
    } as never, // sla
  );
  return { service, claims, prisma };
}

describe('APV level options: deciding', () => {
  it('an `all` step waits after the first approval and does not move the case', async () => {
    const { service, claims } = deciding({ mode: 'all' }, 0);

    await service.decide(
      'case-1',
      { decision: 'approve', note: 'ok' },
      principal('user-a'),
    );

    expect(claims).toHaveLength(0);
  });

  it('an `all` step moves once every candidate approved', async () => {
    const { service, claims } = deciding({ mode: 'all' }, 1);

    await service.decide(
      'case-1',
      { decision: 'approve', note: 'ok' },
      principal('user-b'),
    );

    expect(claims).toHaveLength(1);
  });

  it('lets an approval go without a note when the level allows it', async () => {
    const { service, claims } = deciding(
      { noteRequired: 'reject_or_return' },
      0,
    );

    await service.decide(
      'case-1',
      { decision: 'approve' },
      principal('user-a'),
    );

    expect(claims).toHaveLength(1);
  });

  it('still requires a note on a rejection', async () => {
    const { service } = deciding({ noteRequired: 'reject_or_return' }, 0);

    await expect(
      service.decide('case-1', { decision: 'reject' }, principal('user-a')),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('APV level options: publishing', () => {
  it.each([
    [{ type: 'supervisor', up: 1, mode: 'most' }],
    [{ type: 'supervisor', up: 1, noteRequired: 'never' }],
    [{ type: 'supervisor', up: 1, slaHours: 0 }],
    [
      {
        type: 'supervisor',
        up: 1,
        condition: { field: 'x', op: 'like', value: 1 },
      },
    ],
  ])('refuses a malformed option: %j', (level) => {
    expect(() => assertValidLevels([level])).toThrow(AppError);
  });
});

describe('APV-02: a requester who heads their own group', () => {
  it('climbs to the next head instead of approving their own request', async () => {
    const access = new AccessService(
      {
        ancestorIdsOf: jest.fn(() => Promise.resolve(['ou-team', 'ou-dept'])),
        managersOf: jest.fn(() =>
          Promise.resolve(['user-requester', 'user-dept-head']),
        ),
      } as never,
      {} as never,
    );

    const candidates = await access.approverCandidatesOf(
      { type: 'supervisor', up: 1 },
      { requesterId: 'user-requester', orgUnitId: 'ou-team' },
    );

    expect(candidates).toEqual(['user-dept-head']);
  });
});
