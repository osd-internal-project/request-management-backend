import { AppError } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { RequestsService } from './requests.service';
import { RequestFlowService } from '../request-flow/request-flow.service';
import type { Flow, FlowStep } from './request-flow';
import {
  assertPublishableV2,
  canMove,
  holderOf,
  isSubmitMove,
  statusOnEntry,
  v2Milestones,
  type ScopeStatus,
} from './request-flow-v2';
import { suggestedFlow } from './request-flow-suggest';

const OSD = 'company-osd';
const REQUESTER = 'user-requester';
const WORKER = 'user-worker';

function principal(userId: string, company = OSD): Principal {
  return {
    userId,
    activeCompanyId: company,
    username: userId,
    permissions: ['request.complete', 'request.create', 'request.submit'],
    // Only the fields these paths read.
  } as unknown as Principal;
}

function step(
  code: string,
  sortOrder: number,
  scopeStatus: ScopeStatus,
  overrides: Partial<FlowStep> = {},
): FlowStep {
  return {
    code,
    name: code,
    sortOrder,
    formSchema: null,
    subRequestTypes: [],
    requiresApproval: false,
    assigneeRule: null,
    slaHours: null,
    scopeStatus,
    ...overrides,
  };
}

function forward(from: string, to: string) {
  return {
    fromStepCode: from,
    toStepCode: to,
    sortOrder: 1,
    condition: null,
    backward: false,
  };
}

const LEVELS = [{ type: 'supervisor', up: 1, chartOf: 'requester' }];

/** REQUEST → HEAD (approval, ↩ REQUEST) → RECEIVE → WORK → CONFIRM */
const FLOW: Flow = {
  schemaVersion: 2,
  steps: [
    step('REQUEST', 1, 'draft', {
      formSchema: {
        required: ['reason'],
        properties: { reason: { type: 'string' } },
      },
    }),
    step('HEAD', 2, 'pending_approval', {
      approvalLevels: LEVELS,
      returnToStepCode: 'REQUEST',
    }),
    step('RECEIVE', 3, 'submitted'),
    step('WORK', 4, 'in_progress'),
    step('CONFIRM', 5, 'approved'),
  ],
  transitions: [
    forward('REQUEST', 'HEAD'),
    forward('HEAD', 'RECEIVE'),
    forward('RECEIVE', 'WORK'),
    forward('WORK', 'CONFIRM'),
  ],
};

async function refused(work: Promise<unknown>): Promise<AppError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('flow v2 engine: status is the scope of the step', () => {
  it('moves only along transitions the state machine allows', () => {
    expect(canMove('in_progress', 'pending_approval')).toBe(true);
    expect(canMove('pending_approval', 'in_progress')).toBe(true);
    expect(canMove('in_progress', 'approved')).toBe(true); // through `completed`
    expect(canMove('submitted', 'approved')).toBe(false);
    expect(canMove('approved', 'in_progress')).toBe(false);
  });

  it('treats a draft step reached after submit as returned', () => {
    expect(canMove('pending_approval', 'draft')).toBe(true);
    expect(statusOnEntry('draft', true)).toBe('returned');
    expect(statusOnEntry('draft', false)).toBe('draft');
  });

  it('counts leaving the requester for anyone else as a submit', () => {
    expect(isSubmitMove('draft', 'pending_approval')).toBe(true);
    expect(isSubmitMove('returned', 'submitted')).toBe(true);
    expect(isSubmitMove('draft', 'draft')).toBe(false);
    expect(isSubmitMove('in_progress', 'pending_approval')).toBe(false);
  });

  it('names the holder from the scope, and a stand-in over the requester', () => {
    const facts = {
      requesterId: REQUESTER,
      stepHolderUserId: null,
      receiverUserId: 'user-receiver',
      assigneeUserId: WORKER,
    };
    expect(holderOf('draft', facts)).toBe(REQUESTER);
    expect(holderOf('approved', { ...facts, stepHolderUserId: 'user-x' })).toBe(
      'user-x',
    );
    expect(holderOf('submitted', facts)).toBe('user-receiver');
    expect(holderOf('in_progress', facts)).toBe(WORKER);
    expect(holderOf('pending_approval', facts)).toBeNull();
  });
});

describe('flow v2 engine: publishing', () => {
  const fields = ['reason'];

  it('accepts a flow that starts with the requester and ends with them', () => {
    expect(() => assertPublishableV2(FLOW, fields)).not.toThrow();
  });

  it('refuses a first step that is not the requester’s', async () => {
    const flow: Flow = {
      ...FLOW,
      steps: FLOW.steps.map((s) =>
        s.code === 'REQUEST' ? { ...s, scopeStatus: 'in_progress' } : s,
      ),
    };
    const error = await refused(
      Promise.resolve().then(() => assertPublishableV2(flow, fields)),
    );
    expect(error.details).toContainEqual({
      field: 'steps.REQUEST.scope',
      reason: 'ขั้นแรกต้องอยู่ใต้ "ร่าง / ยื่นคำขอ"',
    });
  });

  it('refuses an approval step with no way back', async () => {
    const flow: Flow = {
      ...FLOW,
      steps: FLOW.steps.map((s) =>
        s.code === 'HEAD' ? { ...s, returnToStepCode: null } : s,
      ),
    };
    const error = await refused(
      Promise.resolve().then(() => assertPublishableV2(flow, fields)),
    );
    expect(error.details).toContainEqual({
      field: 'steps.HEAD.returnToStepCode',
      reason: 'เลือกขั้นที่จะส่งกลับไป',
    });
  });

  it('refuses an exit that skips across statuses', async () => {
    const flow: Flow = {
      ...FLOW,
      transitions: FLOW.transitions
        .filter((t) => t.fromStepCode !== 'WORK')
        .map((t) =>
          t.fromStepCode === 'RECEIVE' ? { ...t, toStepCode: 'CONFIRM' } : t,
        ),
      steps: FLOW.steps.filter((s) => s.code !== 'WORK'),
    };
    const error = await refused(
      Promise.resolve().then(() => assertPublishableV2(flow, fields)),
    );
    expect(error.details).toContainEqual({
      field: 'transitions.RECEIVE->CONFIRM',
      reason: 'ย้ายจาก submitted ไป approved ไม่ได้',
    });
  });
});

describe('flow v2: สร้าง flow จากค่าเดิม', () => {
  it('restates the fixed lifecycle with both ladders copied into steps', () => {
    const suggestion = suggestedFlow({
      formSchema: { properties: { reason: { type: 'string' } } },
      requiredDocs: [{ code: 'QUOTE', name: 'ใบเสนอราคา' }],
      receiverFormSchema: null,
      subRequestTypes: [],
      preLevels: [{ type: 'supervisor', up: 1 }],
      postLevels: [{ type: 'org', orgUnitIds: ['ou-it'] }],
    });

    expect(suggestion.steps.map((s) => [s.code, s.scope_status])).toEqual([
      ['REQUEST', 'draft'],
      ['PRE_APPROVAL', 'pending_approval'],
      ['RECEIVE', 'submitted'],
      ['WORK', 'in_progress'],
      ['RESULT_APPROVAL', 'pending_approval'],
      ['CONFIRM', 'approved'],
    ]);
    expect(suggestion.steps[1].approval_levels).toEqual([
      { type: 'supervisor', up: 1, chartOf: 'requester' },
    ]);
    expect(suggestion.steps[4].return_to_step).toBe('WORK');
    expect(suggestion.transitions).toHaveLength(5);
  });

  it('leaves the approval steps out when the type has no ladder', () => {
    const suggestion = suggestedFlow({
      formSchema: null,
      requiredDocs: [],
      receiverFormSchema: null,
      subRequestTypes: [],
      preLevels: null,
      postLevels: null,
    });

    expect(suggestion.steps.map((s) => s.code)).toEqual([
      'REQUEST',
      'RECEIVE',
      'WORK',
      'CONFIRM',
    ]);
  });
});

function onStep(
  currentStepCode: string,
  status: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: 'req-1',
    requestNo: status === 'draft' ? null : 'OSD-IT-202609-0001',
    companyId: OSD,
    typeCode: 'IT',
    requestTypeId: 'type-it',
    status,
    requesterId: REQUESTER,
    receiverUserId: WORKER,
    assigneeUserId: null,
    stepHolderUserId: null,
    completedAt: null,
    refId: null,
    formData: { reason: 'new laptop' },
    stepFormData: {},
    flowVersionId: 'flow-v2',
    flowVersion: { schemaVersion: 2 },
    currentStepCode,
    requestType: {
      code: 'IT',
      refRequired: false,
      receiverUserId: null,
      subRequestTypes: [],
    },
    attachments: [],
    ...overrides,
  };
}

function serviceWith(request: Record<string, unknown>, caseType = false) {
  const writes: Record<string, unknown>[] = [];
  const prisma = {
    request: {
      update: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        writes.push(data);
        return Promise.resolve({ ...request, ...data });
      }),
    },
    $queryRaw: jest.fn(() => Promise.resolve([])),
    requestEvent: {
      findFirst: jest.fn(() => Promise.resolve(null)),
      create: jest.fn(() => Promise.resolve({})),
    },
  };
  const flows = {
    load: jest.fn(() => Promise.resolve(FLOW)),
    moveV2: jest.fn((...args: unknown[]) => {
      const to = args[4] as string;
      return Promise.resolve(to === 'HEAD' ? FLOW.steps[1] : null);
    }),
    finishV2: jest.fn(() => Promise.resolve()),
    announceV2: jest.fn(() => Promise.resolve()),
  };
  const sla = {
    start: jest.fn(() => Promise.resolve()),
    resume: jest.fn(() => Promise.resolve()),
    pause: jest.fn(() => Promise.resolve()),
    stop: jest.fn(() => Promise.resolve()),
    markResponded: jest.fn(() => Promise.resolve()),
    isCaseType: jest.fn(() => Promise.resolve(caseType)),
  };
  const approvals = {
    openStepCaseV2: jest.fn(() => Promise.resolve()),
    routeForApproval: jest.fn(),
  };
  const runNumbers = {
    issueUnused: jest.fn(() => Promise.resolve('OSD-IT-202609-0002')),
  };

  const service = new RequestsService(
    {
      findWithType: jest.fn(() => Promise.resolve(request)),
      findReceiver: jest.fn((id: string) => Promise.resolve({ id })),
      findChildTypes: jest.fn(() => Promise.resolve([])),
      requestNoTaken: jest.fn(() => Promise.resolve(false)),
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    runNumbers as never,
    approvals as never,
    sla as never,
    {} as never,
    { emit: jest.fn(() => Promise.resolve()) } as never,
    { record: jest.fn(() => Promise.resolve()) } as never,
    {
      execute: jest.fn((work: (client: unknown) => unknown) => work(prisma)),
    } as never,
    flows as never,
  );
  jest.spyOn(service, 'findOne').mockResolvedValue({} as never);
  // The snapshot's sub-request names are not what these tests are about.
  jest
    .spyOn(
      service as unknown as { namedSubRequestTypes: () => Promise<unknown[]> },
      'namedSubRequestTypes',
    )
    .mockResolvedValue([]);

  return { service, writes, flows, sla, approvals, runNumbers };
}

describe('flow v2 service: submit is leaving the first step', () => {
  it('issues the number and opens the approval step after commit', async () => {
    const { service, writes, flows, sla, approvals, runNumbers } = serviceWith(
      onStep('REQUEST', 'draft'),
    );

    await service.submit('req-1', principal(REQUESTER), 'Bearer t');

    expect(runNumbers.issueUnused).toHaveBeenCalledTimes(1);
    expect(writes[0]).toMatchObject({ requestNo: 'OSD-IT-202609-0002' });
    expect(sla.start).toHaveBeenCalledTimes(1);
    expect(flows.moveV2.mock.calls[0].slice(3, 6)).toEqual([
      'REQUEST',
      'HEAD',
      'forward',
    ]);
    expect(approvals.openStepCaseV2).toHaveBeenCalledWith(
      'req-1',
      expect.anything(),
    );
    expect(approvals.routeForApproval).not.toHaveBeenCalled();
  });

  it('CD-282: a matter AI CARE took earlier is submitted, and timed, from then', async () => {
    const { service, writes, sla } = serviceWith(onStep('REQUEST', 'draft'));
    const receivedAt = new Date(Date.now() - 30 * 60_000);
    await service.submit('req-1', principal(REQUESTER), 'Bearer t', {
      receivedAt,
    });
    expect(writes[0]).toMatchObject({ submittedAt: receivedAt });
    expect(sla.start).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      receivedAt,
    );
  });

  it('refuses when the first step’s form is incomplete, before any number', async () => {
    const { service, runNumbers, flows } = serviceWith(
      onStep('REQUEST', 'draft', { formData: {} }),
    );

    const error = await refused(
      service.submit('req-1', principal(REQUESTER), 'Bearer t'),
    );

    expect(error.code).toBe('REQ_FIELD_MISSING');
    expect(runNumbers.issueUnused).not.toHaveBeenCalled();
    expect(flows.moveV2).not.toHaveBeenCalled();
  });

  it('refuses someone who does not hold the step', async () => {
    const { service, flows } = serviceWith(onStep('REQUEST', 'draft'));

    const error = await refused(
      service.submit('req-1', principal('user-bystander'), 'Bearer t'),
    );

    expect(error.code).toBe('FORBIDDEN');
    expect(flows.moveV2).not.toHaveBeenCalled();
  });

  it('lets the requester’s stand-in submit', async () => {
    const { service, flows } = serviceWith(
      onStep('REQUEST', 'draft', { stepHolderUserId: 'user-standin' }),
    );

    await service.submit('req-1', principal('user-standin'), 'Bearer t');

    expect(flows.moveV2).toHaveBeenCalledTimes(1);
  });

  it('keeps the number on a resubmit after a return', async () => {
    const { service, runNumbers, sla } = serviceWith(
      onStep('REQUEST', 'returned'),
    );

    await service.advance(
      'req-1',
      { to_step: 'HEAD' },
      principal(REQUESTER),
      'Bearer t',
    );

    expect(runNumbers.issueUnused).not.toHaveBeenCalled();
    expect(sla.start).not.toHaveBeenCalled();
  });

  it('answers NOT_FOUND for another company', async () => {
    const { service } = serviceWith(onStep('REQUEST', 'draft'));

    const error = await refused(
      service.submit(
        'req-1',
        principal(REQUESTER, 'company-other'),
        'Bearer t',
      ),
    );

    expect(error.code).toBe('NOT_FOUND');
  });
});

describe('flow v2 service: moving through the steps', () => {
  it('waits for the receiver: advance is refused on a submitted step', async () => {
    const { service } = serviceWith(onStep('RECEIVE', 'submitted'));

    const error = await refused(
      service.advance(
        'req-1',
        { to_step: 'WORK' },
        principal(WORKER),
        'Bearer t',
      ),
    );

    expect(error.code).toBe('REQ_STEP_INVALID');
  });

  it('receive moves on to the worker step and starts the clock', async () => {
    const { service, flows, sla } = serviceWith(onStep('RECEIVE', 'submitted'));

    await service.receive('req-1', principal(WORKER));

    expect(flows.moveV2.mock.calls[0].slice(3, 6)).toEqual([
      'RECEIVE',
      'WORK',
      'forward',
    ]);
    expect(sla.resume).toHaveBeenCalledTimes(1);
  });

  it('leaving the last step closes the request and stops the clock', async () => {
    const { service, flows, sla } = serviceWith(onStep('CONFIRM', 'approved'));

    await service.advance(
      'req-1',
      { to_step: 'END' },
      principal(REQUESTER),
      'Bearer t',
    );

    expect(flows.finishV2).toHaveBeenCalledTimes(1);
    expect(sla.stop).toHaveBeenCalledWith(expect.anything(), 'req-1', 'met');
  });

  it('does not pause the clock on the way into an approval step (D7)', async () => {
    const { service, sla } = serviceWith(
      onStep('WORK', 'in_progress', { assigneeUserId: WORKER }),
    );
    const flowWithCheck: Flow = {
      ...FLOW,
      transitions: FLOW.transitions.map((t) =>
        t.fromStepCode === 'WORK' ? { ...t, toStepCode: 'HEAD' } : t,
      ),
    };
    jest
      .spyOn(
        (service as unknown as { flows: { load: jest.Mock } }).flows,
        'load',
      )
      .mockResolvedValue(flowWithCheck);

    await service.advance(
      'req-1',
      { to_step: 'HEAD' },
      principal(WORKER),
      'Bearer t',
    );

    expect(sla.pause).not.toHaveBeenCalled();
  });

  it('retires the fixed verbs on a v2 request', async () => {
    const { service } = serviceWith(
      onStep('WORK', 'in_progress', { assigneeUserId: WORKER }),
    );

    const error = await refused(
      service.complete('req-1', principal(WORKER), 'Bearer t'),
    );

    expect(error.code).toBe('REQ_STEP_INVALID');
  });
});

describe('flow v2 service: handing a step on', () => {
  it('a requester step goes to a stand-in, not to the assignee column', async () => {
    const { service, writes } = serviceWith(onStep('REQUEST', 'returned'));

    await service.assign(
      'req-1',
      { assignee_user_id: 'user-standin' },
      principal(REQUESTER),
    );

    expect(writes[0]).toMatchObject({ stepHolderUserId: 'user-standin' });
    expect(writes[0]).not.toHaveProperty('assigneeUserId');
  });

  it('refuses a stranger handing on the requester’s step', async () => {
    const { service, writes } = serviceWith(onStep('REQUEST', 'returned'));

    const error = await refused(
      service.assign(
        'req-1',
        { assignee_user_id: 'user-standin' },
        principal(WORKER),
      ),
    );

    expect(error.code).toBe('FORBIDDEN');
    expect(writes).toHaveLength(0);
  });

  it('an approval step is handed on by delegation instead', async () => {
    const { service } = serviceWith(
      onStep('HEAD', 'pending_approval', { receiverUserId: WORKER }),
    );

    const error = await refused(
      service.assign(
        'req-1',
        { assignee_user_id: 'user-x' },
        principal(WORKER),
      ),
    );

    expect(error.code).toBe('REQ_STEP_INVALID');
  });
});

describe('flow v2 runtime: where a decision lands', () => {
  function runtimeFor(request: Record<string, unknown>) {
    const writes: Record<string, unknown>[] = [];
    const prisma = {
      request: {
        findUniqueOrThrow: jest.fn(() => Promise.resolve(request)),
        update: jest.fn(({ data }: { data: Record<string, unknown> }) => {
          writes.push(data);
          return Promise.resolve({});
        }),
      },
      requestStepRun: {
        create: jest.fn(() => Promise.resolve({})),
        updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
        findFirst: jest.fn(() => Promise.resolve(null)),
      },
      $queryRaw: jest.fn(() => Promise.resolve([])),
      requestEvent: {
        findFirst: jest.fn(() => Promise.resolve(null)),
        create: jest.fn(() => Promise.resolve({})),
      },
    };
    const runtime = new RequestFlowService({} as never, {} as never);
    jest.spyOn(runtime, 'load').mockResolvedValue(FLOW);
    return { runtime, prisma, writes };
  }

  const waiting = onStep('HEAD', 'pending_approval');

  it('send back returns the work to the requester as returned', async () => {
    const { runtime, prisma, writes } = runtimeFor(waiting);

    await runtime.afterDecisionV2(
      prisma as never,
      'req-1',
      'return',
      principal('user-head'),
    );

    expect(writes[0]).toMatchObject({
      currentStepCode: 'REQUEST',
      status: 'returned',
      stepHolderUserId: null,
    });
  });

  it('approve moves on to the receiver with the named receiver kept', async () => {
    const { runtime, prisma, writes } = runtimeFor(waiting);

    await runtime.afterDecisionV2(
      prisma as never,
      'req-1',
      'approve',
      principal('user-head'),
    );

    expect(writes[0]).toMatchObject({
      currentStepCode: 'RECEIVE',
      status: 'submitted',
      receiverUserId: WORKER,
    });
  });
});

describe('flow v2 after the merge: remote features reach the v2 paths', () => {
  it('I1: a case type cannot be submitted without a severity', async () => {
    const { service, runNumbers } = serviceWith(
      onStep('REQUEST', 'draft', { severity: null }),
      true,
    );

    const error = await refused(
      service.submit('req-1', principal(REQUESTER), 'Bearer t'),
    );

    expect(error.details).toContainEqual({
      field: 'severity',
      reason: 'required',
    });
    expect(runNumbers.issueUnused).not.toHaveBeenCalled();
  });

  it('I2: receiving a v2 step is the receiving side responding', async () => {
    const { service, sla } = serviceWith(onStep('RECEIVE', 'submitted'));

    await service.receive('req-1', principal(WORKER));

    expect(sla.markResponded).toHaveBeenCalledTimes(1);
  });

  it('I3: a computed field is worked out, not taken from the caller', async () => {
    const computed: Flow = {
      ...FLOW,
      steps: FLOW.steps.map((s) =>
        s.code === 'WORK'
          ? {
              ...s,
              formSchema: {
                properties: {
                  deal_value: { type: 'number' },
                  cost: { type: 'number' },
                  margin: {
                    type: 'number',
                    'x-computed': {
                      kind: 'margin_pct',
                      value: 'deal_value',
                      cost: 'cost',
                    },
                  },
                },
              },
            }
          : s,
      ),
    };
    const { service, writes, flows } = serviceWith(
      onStep('WORK', 'in_progress', { assigneeUserId: WORKER }),
    );
    flows.load.mockResolvedValue(computed);

    await service.saveStepForm(
      'req-1',
      { data: { deal_value: 100, cost: 60, margin: 999 } },
      principal(WORKER),
    );

    const saved = writes[0].stepFormData as Record<
      string,
      Record<string, unknown>
    >;
    expect(saved.WORK.margin).toBe(40);
  });

  it('I4: every v2 move is announced after commit', async () => {
    const { service, flows } = serviceWith(onStep('CONFIRM', 'approved'));

    await service.advance(
      'req-1',
      { to_step: 'END' },
      principal(REQUESTER),
      'Bearer t',
    );

    expect(flows.announceV2).toHaveBeenCalledWith(
      'req-1',
      expect.objectContaining({ status: 'approved' }),
    );
  });
});

describe('flow v2 milestones: the v1 events a move stands for', () => {
  it('I4: reaching approved the first time is completed, then approved', () => {
    expect(
      v2Milestones(
        { status: 'pending_approval', completedAt: null },
        { status: 'approved', completedAt: new Date() },
      ),
    ).toEqual(['completed', 'approved']);
  });

  it('I4: an approval step that hands the ticket to its receiver is a pre-work approval', () => {
    expect(
      v2Milestones(
        { status: 'pending_approval', completedAt: null },
        { status: 'submitted', completedAt: null },
      ),
    ).toEqual(['preApproved']);
  });

  it('I4: an approval in the middle of the work, or a second approval, announces nothing', () => {
    expect(
      v2Milestones(
        { status: 'pending_approval', completedAt: null },
        { status: 'in_progress', completedAt: null },
      ),
    ).toEqual([]);
    expect(
      v2Milestones(
        { status: 'pending_approval', completedAt: new Date() },
        { status: 'approved', completedAt: new Date() },
      ),
    ).toEqual([]);
  });
});

describe('flow v2 service: a receiver sends a submitted step back', () => {
  const withBackward: Flow = {
    ...FLOW,
    transitions: [
      ...FLOW.transitions,
      { ...forward('RECEIVE', 'REQUEST'), backward: true },
    ],
  };

  it('moves backward to the requester step', async () => {
    const { service, flows } = serviceWith(onStep('RECEIVE', 'submitted'));
    flows.load.mockResolvedValue(withBackward);

    await service.advance(
      'req-1',
      { to_step: 'REQUEST' },
      principal(WORKER),
      'Bearer t',
    );

    expect(flows.moveV2.mock.calls[0].slice(3, 6)).toEqual([
      'RECEIVE',
      'REQUEST',
      'backward',
    ]);
  });

  it('refuses the requester sending back a step the receiver holds', async () => {
    const { service, flows } = serviceWith(onStep('RECEIVE', 'submitted'));
    flows.load.mockResolvedValue(withBackward);

    const error = await refused(
      service.advance(
        'req-1',
        { to_step: 'REQUEST' },
        principal(REQUESTER),
        'Bearer t',
      ),
    );

    expect(error.code).toBe('FORBIDDEN');
  });

  it('refuses saving a step form on a submitted step', async () => {
    const { service } = serviceWith(onStep('RECEIVE', 'submitted'));

    const error = await refused(
      service.saveStepForm('req-1', { data: {} }, principal(WORKER)),
    );

    expect(error.code).toBe('REQ_STEP_INVALID');
  });
});

describe('flow v2 service: files on a requester step', () => {
  const SIGNED = { code: 'SIGNED', name: 'เอกสารที่ลงนาม', required: true };
  const withDocs: Flow = {
    ...FLOW,
    steps: FLOW.steps.map((s) =>
      s.code === 'CONFIRM' ? { ...s, requiredDocs: [SIGNED] } : s,
    ),
  };

  it('lets the requester attach on the closing step, and knows its documents', async () => {
    const request = onStep('CONFIRM', 'approved');
    const { service, flows } = serviceWith(request);
    flows.load.mockResolvedValue(withDocs);

    const found = await service.requireEditableOwn(
      'req-1',
      principal(REQUESTER),
      'แนบเอกสาร',
    );

    expect(await service.attachableDocs(found)).toEqual([SIGNED]);
  });

  it('refuses someone who does not hold the requester step', async () => {
    const { service } = serviceWith(onStep('CONFIRM', 'approved'));

    const error = await refused(
      service.requireEditableOwn('req-1', principal(WORKER), 'แนบเอกสาร'),
    );

    expect(error.code).toBe('FORBIDDEN');
  });

  it('refuses the requester attaching while the team holds the work', async () => {
    const { service } = serviceWith(onStep('WORK', 'in_progress'));

    const error = await refused(
      service.requireEditableOwn('req-1', principal(REQUESTER), 'แนบเอกสาร'),
    );

    expect(error.code).toBe('REQ_STATE_INVALID');
  });

  it('leaves a request with no flow on the draft/returned rule', async () => {
    const { service } = serviceWith(
      onStep('CONFIRM', 'approved', { flowVersionId: null, flowVersion: null }),
    );

    const error = await refused(
      service.requireEditableOwn('req-1', principal(REQUESTER), 'แนบเอกสาร'),
    );

    expect(error.code).toBe('REQ_STATE_INVALID');
  });
});
