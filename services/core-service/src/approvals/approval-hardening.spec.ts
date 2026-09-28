import { AppError } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { ApprovalsService } from './approvals.service';
import { RequestsService } from '../requests/requests.service';

const OSD = 'company-osd';
const REQUESTER = 'user-requester';
const APPROVER = 'user-approver';

function principal(userId: string): Principal {
  return {
    userId,
    activeCompanyId: OSD,
    username: userId,
    permissions: ['approval.decide', 'request.create', 'request.return'],
    scopeGrants: [],
    // Only the fields these paths read.
  } as unknown as Principal;
}

function pendingCase(requestStatus = 'pending_approval') {
  return {
    id: 'case-1',
    companyId: OSD,
    status: 'pending',
    currentStep: 1,
    subjectType: 'request:DSC',
    requestId: 'req-1',
    createdBy: REQUESTER,
    steps: [
      {
        id: 'step-1',
        stepNo: 1,
        status: 'pending',
        candidateUserIds: [APPROVER],
        approverUserId: APPROVER,
      },
    ],
    request: {
      requesterId: REQUESTER,
      receiverUserId: null,
      assigneeUserId: null,
      requesterOrgUnitId: null,
      receiverOrgUnitId: null,
      typeCode: 'DSC',
      requestNo: 'OSD-DSC-202609-0001',
      status: requestStatus,
    },
  };
}

function approvalsWith(options: {
  found?: ReturnType<typeof pendingCase>;
  claimed?: number;
  delegation?: { id: string } | null;
}) {
  const requestUpdates: Record<string, unknown>[] = [];
  const caseUpdates: Record<string, unknown>[] = [];
  const audits: Record<string, unknown>[] = [];

  const prisma = {
    approvalCase: {
      findUnique: jest.fn(() =>
        Promise.resolve(options.found ?? pendingCase()),
      ),
      findMany: jest.fn(() =>
        Promise.resolve([{ id: 'case-1', companyId: OSD }]),
      ),
      updateMany: jest.fn((args: Record<string, unknown>) => {
        caseUpdates.push(args);
        return Promise.resolve({ count: options.claimed ?? 1 });
      }),
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
      update: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        requestUpdates.push(data);
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
    {
      findActiveFor: jest.fn(() => Promise.resolve(options.delegation ?? null)),
    } as never,
    {} as never,
    {} as never,
    {} as never,
    { decisionMade: jest.fn(() => Promise.resolve()) } as never,
    { emit: jest.fn(() => Promise.resolve()) } as never,
    {
      record: jest.fn((entry: Record<string, unknown>) => {
        audits.push(entry);
        return Promise.resolve();
      }),
    } as never,
    {
      execute: jest.fn((work: (client: unknown) => unknown) => work(prisma)),
    } as never,
    {} as never, // flows,
    {
      stop: jest.fn(() => Promise.resolve()),
      resume: jest.fn(() => Promise.resolve()),
      pause: jest.fn(() => Promise.resolve()),
      dueAfter: jest.fn(() => Promise.resolve(null)),
    } as never, // sla
  );

  return { service, prisma, requestUpdates, caseUpdates, audits };
}

async function refused(work: Promise<unknown>): Promise<AppError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('APV hardening: a decision only lands on a request still waiting for it', () => {
  it('refuses a stale case whose request was cancelled, and writes nothing', async () => {
    const { service, requestUpdates, caseUpdates } = approvalsWith({
      found: pendingCase('cancelled'),
    });

    const error = await refused(
      service.decide(
        'case-1',
        { decision: 'approve', note: 'ok' },
        principal(APPROVER),
      ),
    );

    expect(error.code).toBe('REQ_STATE_INVALID');
    expect(requestUpdates).toHaveLength(0);
    expect(caseUpdates).toHaveLength(0);
  });

  it('refuses the second of two racing decisions', async () => {
    const { service, requestUpdates } = approvalsWith({ claimed: 0 });

    const error = await refused(
      service.decide(
        'case-1',
        { decision: 'approve', note: 'ok' },
        principal(APPROVER),
      ),
    );

    expect(error.code).toBe('CONFLICT');
    expect(requestUpdates).toHaveLength(0);
  });

  it('claims the case only while it is pending on the step that was read', async () => {
    const { service, caseUpdates } = approvalsWith({});

    await service.decide(
      'case-1',
      { decision: 'approve', note: 'ok' },
      principal(APPROVER),
    );

    expect(caseUpdates[0]).toMatchObject({
      where: { id: 'case-1', status: 'pending', currentStep: 1 },
    });
  });
});

describe('APV-02: nobody approves their own request', () => {
  it('refuses the requester even while they hold a delegation from the approver', async () => {
    const { service, requestUpdates } = approvalsWith({
      delegation: { id: 'delegation-1' },
    });

    const error = await refused(
      service.decide(
        'case-1',
        { decision: 'approve', note: 'ok' },
        principal(REQUESTER),
      ),
    );

    expect(error.code).toBe('APV_SELF_APPROVAL');
    expect(requestUpdates).toHaveLength(0);
  });
});

describe('APV hardening: closing open cases when the request moves on', () => {
  it('closes only pending cases and audits each one', async () => {
    const { service, prisma, caseUpdates, audits } = approvalsWith({});

    await service.closeOpenCases(
      prisma as never,
      'req-1',
      'cancelled',
      principal(REQUESTER),
    );

    expect(caseUpdates[0]).toMatchObject({
      where: { id: { in: ['case-1'] }, status: 'pending' },
      data: { status: 'cancelled' },
    });
    expect(audits.map((entry) => entry.eventType)).toEqual([
      'approval.case.cancelled',
    ]);
  });
});

function awaitingRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: 'req-1',
    requestNo: 'OSD-DSC-202609-0001',
    companyId: OSD,
    typeCode: 'DSC',
    status: 'pending_approval',
    requesterId: REQUESTER,
    receiverUserId: 'user-receiver',
    assigneeUserId: null,
    requesterOrgUnitId: null,
    receiverOrgUnitId: null,
    formData: {},
    refId: null,
    requestType: {
      approvalPolicy: {},
      returnReasonCodes: [{ code: 'DOC', name: 'เอกสารไม่ครบ' }],
      formSchema: { properties: { title: { type: 'string' } } },
      requiredDocs: [],
      refRequired: false,
      receiverUserId: null,
    },
    attachments: [],
    ...overrides,
  };
}

function requestsWith(request: Record<string, unknown>, routable = true) {
  const closeOpenCases = jest.fn(() => Promise.resolve());
  const issueUnused = jest.fn(() => Promise.resolve('OSD-DSC-202609-0001'));
  const prisma = {
    request: {
      update: jest.fn(() => Promise.resolve({})),
      // `settleWorkClock` reads where the decision left the request.
      findUniqueOrThrow: jest.fn(() =>
        Promise.resolve({ status: 'in_progress' }),
      ),
    },
    requestReturnReason: { create: jest.fn(() => Promise.resolve({})) },
    $queryRaw: jest.fn(() => Promise.resolve([])),
    requestEvent: {
      findFirst: jest.fn(() => Promise.resolve(null)),
      create: jest.fn(() => Promise.resolve({ id: 'event-1' })),
    },
  };

  const service = new RequestsService(
    {
      findWithType: jest.fn(() => Promise.resolve(request)),
      findReceiver: jest.fn(() => Promise.resolve({ id: 'user-receiver' })),
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { issueUnused } as never,
    {
      closeOpenCases,
      assertRoutable: jest.fn(() =>
        routable
          ? Promise.resolve()
          : Promise.reject(
              new AppError('ORG_SUPERVISOR_MISSING', 'ไม่มีหัวหน้า'),
            ),
      ),
    } as never,
    {
      stop: jest.fn(() => Promise.resolve()),
      pause: jest.fn(() => Promise.resolve()),
      isCaseType: jest.fn(() => Promise.resolve(false)),
    } as never,
    { approvalWithdrawn: jest.fn(() => Promise.resolve()) } as never,
    { emit: jest.fn(() => Promise.resolve()) } as never,
    { record: jest.fn(() => Promise.resolve()) } as never,
    {
      execute: jest.fn((work: (client: unknown) => unknown) => work(prisma)),
    } as never,
    {} as never, // flows
  );

  return { service, closeOpenCases, issueUnused };
}

describe('APV hardening: the request routes close their open case', () => {
  it('cancels the open case when a waiting request is cancelled', async () => {
    const { service, closeOpenCases } = requestsWith(awaitingRequest());

    await service.cancel(
      'req-1',
      { reason: 'ไม่ต้องการแล้ว' },
      principal(REQUESTER),
    );

    expect(closeOpenCases).toHaveBeenCalledWith(
      expect.anything(),
      'req-1',
      'cancelled',
      expect.anything(),
    );
  });

  it('leaves cases alone when the request was not waiting on one', async () => {
    const { service, closeOpenCases } = requestsWith(
      awaitingRequest({ status: 'draft' }),
    );

    await service.cancel(
      'req-1',
      { reason: 'ไม่ต้องการแล้ว' },
      principal(REQUESTER),
    );

    expect(closeOpenCases).not.toHaveBeenCalled();
  });
});

describe('APV hardening: submit proves the route before it writes', () => {
  it('issues no number when the pre-work ladder cannot resolve', async () => {
    const { service, issueUnused } = requestsWith(
      awaitingRequest({ status: 'draft', formData: { title: 'x' } }),
      false,
    );

    const error = await refused(
      service.submit('req-1', principal(REQUESTER), 'Bearer token'),
    );

    expect(error.code).toBe('ORG_SUPERVISOR_MISSING');
    expect(issueUnused).not.toHaveBeenCalled();
  });
});
