import type { Principal } from '@request-management/share';
import { RequestFlowService } from './request-flow.service';
import { ApprovalsService } from '../approvals/approvals.service';

const OSD = 'company-osd';

function principal(userId: string): Principal {
  return {
    userId,
    activeCompanyId: OSD,
    username: userId,
    permissions: ['approval.decide'],
    // Only the fields these paths read.
  } as unknown as Principal;
}

/** A published version row as `findVersion` returns it. */
const VERSION_ROW = {
  id: 'flow-v1',
  steps: [
    {
      code: 'DOCS',
      name: 'ตรวจเอกสาร',
      sortOrder: 1,
      formSchema: null,
      subRequestTypes: [],
      requiresApproval: false,
      assigneeRule: null,
      slaHours: null,
    },
    {
      code: 'INSTALL',
      name: 'ติดตั้ง',
      sortOrder: 2,
      formSchema: null,
      subRequestTypes: [],
      requiresApproval: true,
      assigneeRule: null,
      slaHours: null,
    },
    {
      code: 'SPECIAL',
      name: 'อนุมัติพิเศษ',
      sortOrder: 3,
      formSchema: null,
      subRequestTypes: [],
      requiresApproval: false,
      assigneeRule: { type: 'requester' },
      slaHours: null,
    },
    {
      code: 'TEST',
      name: 'ทดสอบ',
      sortOrder: 4,
      formSchema: null,
      subRequestTypes: [],
      requiresApproval: false,
      assigneeRule: null,
      slaHours: null,
    },
  ],
  transitions: [
    {
      fromStepCode: 'DOCS',
      toStepCode: 'INSTALL',
      sortOrder: 1,
      condition: null,
      backward: false,
    },
    {
      fromStepCode: 'INSTALL',
      toStepCode: 'SPECIAL',
      sortOrder: 1,
      condition: { field: 'amount', op: 'gt', value: 1000 },
      backward: false,
    },
    {
      fromStepCode: 'INSTALL',
      toStepCode: 'TEST',
      sortOrder: 2,
      condition: null,
      backward: false,
    },
    {
      fromStepCode: 'SPECIAL',
      toStepCode: 'TEST',
      sortOrder: 1,
      condition: null,
      backward: false,
    },
  ],
};

function prismaFor(request: Record<string, unknown>) {
  const requestWrites: Record<string, unknown>[] = [];
  const runs: Record<string, unknown>[] = [];
  const events: string[] = [];

  const prisma = {
    request: {
      findUniqueOrThrow: jest.fn(() => Promise.resolve(request)),
      update: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        requestWrites.push(data);
        return Promise.resolve({});
      }),
    },
    requestStepRun: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        runs.push({ entered: data.stepCode });
        return Promise.resolve({});
      }),
      updateMany: jest.fn(
        ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          runs.push({ left: where.stepCode, outcome: data.outcome });
          return Promise.resolve({ count: 1 });
        },
      ),
    },
    $queryRaw: jest.fn(() => Promise.resolve([])),
    requestEvent: {
      findFirst: jest.fn(() => Promise.resolve(null)),
      create: jest.fn(({ data }: { data: { type: string } }) => {
        events.push(data.type);
        return Promise.resolve({});
      }),
    },
  };

  return { prisma, requestWrites, runs, events };
}

const flowService = new RequestFlowService(
  { findVersion: jest.fn(() => Promise.resolve(VERSION_ROW)) } as never,
  { emit: jest.fn(() => Promise.resolve()) } as never,
);

describe('request flow: moving after a step exit approval', () => {
  const waiting = {
    id: 'req-1',
    requesterId: 'user-requester',
    flowVersionId: 'flow-v1',
    currentStepCode: 'INSTALL',
    formData: { amount: 5000 },
    stepFormData: {},
  };

  it('lands on the step the answers select and records both ends of the move', async () => {
    const { prisma, requestWrites, runs, events } = prismaFor(waiting);

    await flowService.advanceAfterApproval(
      prisma as never,
      'req-1',
      principal('user-approver'),
    );

    expect(runs).toEqual([
      { left: 'INSTALL', outcome: 'forward' },
      { entered: 'SPECIAL' },
    ]);
    expect(events).toEqual(['request.step.left', 'request.step.entered']);
    // SPECIAL's assignee rule hands the work to the requester.
    expect(requestWrites[0]).toMatchObject({
      currentStepCode: 'SPECIAL',
      assigneeUserId: 'user-requester',
    });
  });

  it('takes the unconditional exit when the condition does not hold', async () => {
    const { prisma, runs } = prismaFor({
      ...waiting,
      formData: { amount: 10 },
    });

    await flowService.advanceAfterApproval(
      prisma as never,
      'req-1',
      principal('user-approver'),
    );

    expect(runs[1]).toEqual({ entered: 'TEST' });
  });
});

describe('approvals: a step exit case returns the work to the team', () => {
  function decideWith(decision: 'approve' | 'return') {
    const requestWrites: unknown[] = [];
    const advanceAfterApproval = jest.fn(() => Promise.resolve());

    const prisma = {
      approvalCase: {
        findUnique: jest.fn(() =>
          Promise.resolve({
            id: 'case-1',
            companyId: OSD,
            status: 'pending',
            currentStep: 1,
            subjectType: 'request:INST:step:INSTALL',
            requestId: 'req-1',
            createdBy: 'user-requester',
            steps: [
              {
                id: 'step-1',
                stepNo: 1,
                status: 'pending',
                candidateUserIds: ['user-approver'],
                approverUserId: 'user-approver',
              },
            ],
            request: {
              requesterId: 'user-requester',
              receiverUserId: null,
              assigneeUserId: null,
              requesterOrgUnitId: null,
              receiverOrgUnitId: null,
              typeCode: 'INST',
              requestNo: 'OSD-INST-1',
              status: 'pending_approval',
            },
          }),
        ),
        updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
        findUniqueOrThrow: jest.fn(() =>
          Promise.resolve({ id: 'case-1', status: 'approved', steps: [] }),
        ),
      },
      approvalVote: {
        create: jest.fn(() => Promise.resolve({})),
        count: jest.fn(() => Promise.resolve(0)),
      },
      approvalStep: { update: jest.fn(() => Promise.resolve({})) },
      request: {
        findUniqueOrThrow: jest.fn(() =>
          Promise.resolve({ status: 'in_progress' }),
        ),
        update: jest.fn(({ data }: { data: { status: string } }) => {
          requestWrites.push(data.status);
          return Promise.resolve({});
        }),
      },
      $queryRaw: jest.fn(() => Promise.resolve([])),
      requestEvent: {
        findFirst: jest.fn(() => Promise.resolve(null)),
        create: jest.fn(() => Promise.resolve({})),
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
      {
        advanceAfterApproval,
        schemaVersionOf: jest.fn(() => Promise.resolve(1)),
      } as never,
      {
        stop: jest.fn(() => Promise.resolve()),
        resume: jest.fn(() => Promise.resolve()),
        pause: jest.fn(() => Promise.resolve()),
        dueAfter: jest.fn(() => Promise.resolve(null)),
      } as never, // sla
    );

    return { service, requestWrites, advanceAfterApproval, decision };
  }

  it('approve sends it back to in_progress and moves it to the next step', async () => {
    const { service, requestWrites, advanceAfterApproval } =
      decideWith('approve');

    await service.decide(
      'case-1',
      { decision: 'approve', note: 'ok' },
      principal('user-approver'),
    );

    expect(requestWrites).toEqual(['in_progress']);
    expect(advanceAfterApproval).toHaveBeenCalledTimes(1);
  });

  it('return keeps it on the same step', async () => {
    const { service, requestWrites, advanceAfterApproval } =
      decideWith('return');

    await service.decide(
      'case-1',
      { decision: 'return', note: 'fix' },
      principal('user-approver'),
    );

    expect(requestWrites).toEqual(['in_progress']);
    expect(advanceAfterApproval).not.toHaveBeenCalled();
  });
});
