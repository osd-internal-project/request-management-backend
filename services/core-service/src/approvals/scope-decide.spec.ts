import { AppError } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { ApprovalsService } from './approvals.service';

const OSD = 'company-osd';
const NAMED = 'user-named-approver';
const RND_LEAD = 'user-rnd-lead';
const STRANGER = 'user-stranger';

const RND = 'unit-rnd';
const SALE = 'unit-sale';

/**
 * A scope grant carrying `approval.decide` — "ฝ่ายนี้อนุมัติงานของฝ่ายนั้นได้"
 * (7 ก.ย. 2569).
 *
 * The rule these tests hold in place is that the grant only ever **adds** an
 * approver. A step still belongs to whoever the ladder named and to anyone
 * covering for them; if a grant could take that away, a step whose candidate
 * had no matching grant would stall with nobody able to decide it.
 */
function principal(
  userId: string,
  overrides: Partial<Principal> = {},
): Principal {
  return {
    userId,
    username: userId,
    activeCompanyId: OSD,
    permissions: ['approval.decide'],
    scopedByPermission: {},
    // Only the fields this path reads. Double cast because a partial principal
    // no longer overlaps the full one enough for a single one.
    ...overrides,
  } as unknown as Principal;
}

function decidingCase(overrides: Record<string, unknown> = {}) {
  return {
    id: 'case-1',
    companyId: OSD,
    status: 'pending',
    currentStep: 1,
    subjectType: 'request:DSC',
    requestId: 'req-1',
    steps: [
      {
        id: 'step-1',
        stepNo: 1,
        status: 'pending',
        candidateUserIds: [NAMED],
        approverUserId: NAMED,
      },
    ],
    request: {
      requesterId: 'user-requester',
      receiverUserId: null,
      assigneeUserId: null,
      requesterOrgUnitId: RND,
      receiverOrgUnitId: null,
      typeCode: 'DSC',
      requestNo: 'OSD-DSC-202609-0001',
      status: 'pending_approval',
    },
    ...overrides,
  };
}

/** The service with only the collaborators a decision reaches. */
function serviceWith(found: Record<string, unknown> | null = decidingCase()) {
  const stepUpdates: Record<string, unknown>[] = [];
  const emitted: { name: string; payload: Record<string, unknown> }[] = [];

  const prisma = {
    approvalCase: {
      findUnique: jest.fn(() => Promise.resolve(found)),
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
      findUniqueOrThrow: jest.fn(() =>
        Promise.resolve({ id: 'case-1', status: 'approved', steps: [] }),
      ),
    },
    approvalVote: {
      create: jest.fn(() => Promise.resolve({})),
      count: jest.fn(() => Promise.resolve(0)),
    },
    approvalStep: {
      update: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        stepUpdates.push(data);
        return Promise.resolve({ id: 'step-1', ...data });
      }),
    },
    request: {
      update: jest.fn(() => Promise.resolve({})),
      // `settleWorkClock` reads where the decision left the request.
      findUniqueOrThrow: jest.fn(() =>
        Promise.resolve({ status: 'in_progress' }),
      ),
    },
    $queryRaw: jest.fn(() => Promise.resolve([])),
    requestEvent: {
      create: jest.fn(() => Promise.resolve({})),
      findFirst: jest.fn(() => Promise.resolve(null)),
    },
  };

  const service = new ApprovalsService(
    {} as never, // cases
    { findActiveFor: jest.fn(() => Promise.resolve(null)) } as never,
    {} as never, // matrix
    {} as never, // access
    {} as never, // context
    { decisionMade: jest.fn(() => Promise.resolve()) } as never,
    {
      emit: jest.fn((event: (typeof emitted)[number]) => {
        emitted.push(event);
        return Promise.resolve();
      }),
    } as never,
    { record: jest.fn(() => Promise.resolve()) } as never,
    {
      execute: jest.fn((work: (client: unknown) => Promise<unknown>) =>
        work(prisma),
      ),
    } as never,
    {} as never, // flows,
    {
      stop: jest.fn(() => Promise.resolve()),
      resume: jest.fn(() => Promise.resolve()),
      pause: jest.fn(() => Promise.resolve()),
      dueAfter: jest.fn(() => Promise.resolve(null)),
    } as never, // sla
  );

  return { service, stepUpdates, emitted };
}

/**
 * The outcome leaves the approval engine as a domain event once the decision
 * has committed — CD-76 ใบเสนอราคา waits on it instead of reading cases.
 */
describe('the outcome of a finished case is announced', () => {
  const named = principal(NAMED);

  it('emits request.approved when the last step approves', async () => {
    const { service, emitted } = serviceWith();

    await service.decide('case-1', { decision: 'approve', note: 'ok' }, named);

    expect(emitted).toEqual([
      {
        name: 'request.approved',
        payload: {
          company_id: OSD,
          request_id: 'req-1',
          request_no: 'OSD-DSC-202609-0001',
          type_code: 'DSC',
          requester_id: 'user-requester',
        },
      },
    ]);
  });

  it('emits request.rejected on a rejection', async () => {
    const { service, emitted } = serviceWith();

    await service.decide('case-1', { decision: 'reject', note: 'no' }, named);

    expect(emitted.map((event) => event.name)).toEqual(['request.rejected']);
  });

  it('emits nothing for a send-back — the work goes back, nothing is decided', async () => {
    const { service, emitted } = serviceWith();

    await service.decide('case-1', { decision: 'return', note: 'fix' }, named);

    expect(emitted).toEqual([]);
  });

  it('emits nothing for a pre-work approval — that only hands the ticket on', async () => {
    const { service, emitted } = serviceWith(
      decidingCase({ subjectType: 'request:DSC:pre' }),
    );

    await service.decide('case-1', { decision: 'approve', note: 'ok' }, named);

    expect(emitted).toEqual([]);
  });
});

async function refused(work: Promise<unknown>): Promise<AppError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }

  throw new Error('expected the decision to be refused');
}

describe('a scope grant carrying approval.decide', () => {
  it('lets the grant holder decide a step nobody named them on', async () => {
    const { service } = serviceWith();

    await expect(
      service.decide(
        'case-1',
        { decision: 'approve', note: 'ok' },
        principal(RND_LEAD, {
          scopedByPermission: {
            'approval.decide': { unitIds: [RND], userIds: [] },
          },
        }),
      ),
    ).resolves.toBeDefined();
  });

  /** The example this feature was asked for: RND yes, Sale no. */
  it('refuses the same person on a request their grant does not reach', async () => {
    const { service } = serviceWith(
      decidingCase({
        request: {
          requesterId: 'user-requester',
          receiverUserId: null,
          assigneeUserId: null,
          requesterOrgUnitId: SALE,
          receiverOrgUnitId: null,
          status: 'pending_approval',
        },
      }),
    );

    expect(
      (
        await refused(
          service.decide(
            'case-1',
            { decision: 'approve', note: 'ok' },
            principal(RND_LEAD, {
              scopedByPermission: {
                'approval.decide': { unitIds: [RND], userIds: [] },
              },
            }),
          ),
        )
      ).code,
    ).toBe('APV_NOT_YOUR_TURN');
  });

  /**
   * The intersection. A grant is never a way around §5.4: it can only hand out
   * a permission the holder's own roles already carry.
   */
  it('refuses a grant holder whose roles do not carry approval.decide', async () => {
    const { service } = serviceWith();

    expect(
      (
        await refused(
          service.decide(
            'case-1',
            { decision: 'approve', note: 'ok' },
            principal(RND_LEAD, {
              permissions: [],
              scopedByPermission: {
                'approval.decide': { unitIds: [RND], userIds: [] },
              },
            }),
          ),
        )
      ).code,
    ).toBe('APV_NOT_YOUR_TURN');
  });

  /**
   * The failure this whole design is arranged to avoid: if a grant could
   * narrow who decides, a step routed to somebody with no grant would stall.
   */
  it('never takes a step away from the person the ladder named', async () => {
    const { service } = serviceWith();

    await expect(
      service.decide(
        'case-1',
        { decision: 'approve', note: 'ok' },
        principal(NAMED, {
          scopedByPermission: {
            'approval.decide': { unitIds: [SALE], userIds: [] },
          },
        }),
      ),
    ).resolves.toBeDefined();
  });

  it('reaches a grant written to one person, not only to a group', async () => {
    const { service } = serviceWith();

    await expect(
      service.decide(
        'case-1',
        { decision: 'approve', note: 'ok' },
        principal(STRANGER, {
          scopedByPermission: {
            'approval.decide': { unitIds: [], userIds: ['user-requester'] },
          },
        }),
      ),
    ).resolves.toBeDefined();
  });

  /**
   * A case opened by an integration for a subject of its own has no request,
   * so there is nothing for a grant to be matched against. Refusing is the
   * only safe answer — a match invented here would be a grant widening itself.
   */
  it('reaches nothing when the case has no request behind it', async () => {
    const { service } = serviceWith(
      decidingCase({ requestId: null, request: null }),
    );

    expect(
      (
        await refused(
          service.decide(
            'case-1',
            { decision: 'approve', note: 'ok' },
            principal(RND_LEAD, {
              scopedByPermission: {
                'approval.decide': { unitIds: [RND], userIds: [] },
              },
            }),
          ),
        )
      ).code,
    ).toBe('APV_NOT_YOUR_TURN');
  });
});
