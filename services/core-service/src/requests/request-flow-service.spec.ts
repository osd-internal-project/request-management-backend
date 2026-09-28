import { AppError } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { RequestsService } from './requests.service';
import type { Flow, FlowStep } from './request-flow';

const OSD = 'company-osd';
const WORKER = 'user-worker';

function principal(userId = WORKER, company = OSD): Principal {
  return {
    userId,
    activeCompanyId: company,
    username: userId,
    permissions: ['request.complete', 'request.create'],
    // Only the fields these paths read.
  } as unknown as Principal;
}

function step(
  code: string,
  sortOrder: number,
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
    ...overrides,
  };
}

/** DOCS → INSTALL (exit ladder) → TEST; TEST ↩ DOCS */
const FLOW: Flow = {
  steps: [
    step('DOCS', 1, {
      formSchema: {
        required: ['checked'],
        properties: { checked: { type: 'string' } },
      },
    }),
    step('INSTALL', 2, { requiresApproval: true }),
    step('TEST', 3),
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
      toStepCode: 'TEST',
      sortOrder: 1,
      condition: null,
      backward: false,
    },
    {
      fromStepCode: 'TEST',
      toStepCode: 'DOCS',
      sortOrder: 1,
      condition: null,
      backward: true,
    },
  ],
};

function onStep(
  currentStepCode: string | null,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: 'req-1',
    requestNo: 'OSD-INST-202609-0001',
    companyId: OSD,
    typeCode: 'INST',
    requestTypeId: 'type-inst',
    status: 'in_progress',
    requesterId: 'user-requester',
    receiverUserId: WORKER,
    assigneeUserId: WORKER,
    formData: {},
    stepFormData: { DOCS: { checked: 'yes' } },
    flowVersionId: 'flow-v1',
    currentStepCode,
    typeSnapshot: { code: 'INST' },
    requestType: { approvalPolicy: {}, subRequestTypes: [] },
    attachments: [],
    ...overrides,
  };
}

function serviceWith(options: {
  request: Record<string, unknown>;
  hasLadder?: boolean;
}) {
  const moves: unknown[][] = [];
  const statusWrites: unknown[] = [];
  const openCase = jest.fn(() =>
    Promise.resolve({
      id: 'case-1',
      status: 'pending',
      steps: [{ stepNo: 1 }],
    }),
  );

  const prisma = {
    request: {
      update: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        statusWrites.push(data.status);
        return Promise.resolve({ id: 'req-1', ...data });
      }),
    },
    approvalCase: { update: jest.fn(() => Promise.resolve({})) },
    $queryRaw: jest.fn(() => Promise.resolve([])),
    requestEvent: {
      findFirst: jest.fn(() => Promise.resolve(null)),
      create: jest.fn(() => Promise.resolve({})),
    },
  };

  const flows = {
    load: jest.fn(() => Promise.resolve(FLOW)),
    move: jest.fn((...args: unknown[]) => {
      moves.push(args.slice(3, 6));
      return Promise.resolve();
    }),
    leave: jest.fn(() => Promise.resolve()),
  };

  const service = new RequestsService(
    {
      findWithType: jest.fn(() => Promise.resolve(options.request)),
      findOpenChildren: jest.fn(() => Promise.resolve([])),
      findChildTypes: jest.fn(() => Promise.resolve([])),
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {
      hasPublishedMatrix: jest.fn(() =>
        Promise.resolve(options.hasLadder ?? true),
      ),
      openCase,
    } as never,
    {
      stop: jest.fn(() => Promise.resolve()),
      pause: jest.fn(() => Promise.resolve()),
    } as never,
    {} as never,
    { emit: jest.fn(() => Promise.resolve()) } as never,
    { record: jest.fn(() => Promise.resolve()) } as never,
    {
      execute: jest.fn((work: (client: unknown) => unknown) => work(prisma)),
    } as never,
    flows as never,
  );
  jest.spyOn(service, 'findOne').mockResolvedValue({} as never);

  return { service, moves, statusWrites, openCase };
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

describe('request flow: advance', () => {
  it('moves forward along the exit the answers select', async () => {
    const { service, moves } = serviceWith({ request: onStep('DOCS') });

    await service.advance(
      'req-1',
      { to_step: 'INSTALL' },
      principal(),
      'Bearer t',
    );

    expect(moves).toEqual([['DOCS', 'INSTALL', 'forward']]);
  });

  it('refuses a step the current one does not lead to', async () => {
    const { service, moves } = serviceWith({ request: onStep('DOCS') });

    const error = await refused(
      service.advance('req-1', { to_step: 'TEST' }, principal(), 'Bearer t'),
    );

    expect(error.code).toBe('REQ_STEP_INVALID');
    expect(moves).toHaveLength(0);
  });

  it('refuses to leave a step whose form is incomplete', async () => {
    const { service, moves } = serviceWith({
      request: onStep('DOCS', { stepFormData: {} }),
    });

    const error = await refused(
      service.advance('req-1', { to_step: 'INSTALL' }, principal(), 'Bearer t'),
    );

    expect(error.code).toBe('REQ_FIELD_MISSING');
    expect(moves).toHaveLength(0);
  });

  it('routes a step with an exit ladder into pending_approval instead of moving', async () => {
    const { service, moves, statusWrites, openCase } = serviceWith({
      request: onStep('INSTALL'),
    });

    await service.advance(
      'req-1',
      { to_step: 'TEST' },
      principal(),
      'Bearer t',
    );

    expect(openCase).toHaveBeenCalledWith(
      expect.objectContaining({ subject_type: 'request:INST:step:INSTALL' }),
      expect.anything(),
      'Bearer t',
    );
    expect(statusWrites).toContain('pending_approval');
    expect(moves).toHaveLength(0);
  });

  it('moves straight on when the step ladder was never published', async () => {
    const { service, moves, openCase } = serviceWith({
      request: onStep('INSTALL'),
      hasLadder: false,
    });

    await service.advance(
      'req-1',
      { to_step: 'TEST' },
      principal(),
      'Bearer t',
    );

    expect(openCase).not.toHaveBeenCalled();
    expect(moves).toEqual([['INSTALL', 'TEST', 'forward']]);
  });

  it('goes back along a configured backward exit without checking the form', async () => {
    const { service, moves } = serviceWith({
      request: onStep('TEST', { stepFormData: {} }),
    });

    await service.advance(
      'req-1',
      { to_step: 'DOCS' },
      principal(),
      'Bearer t',
    );

    expect(moves).toEqual([['TEST', 'DOCS', 'backward']]);
  });

  it('refuses a request that has no flow', async () => {
    const { service } = serviceWith({
      request: onStep(null, { flowVersionId: null }),
    });

    const error = await refused(
      service.advance('req-1', { to_step: 'INSTALL' }, principal(), 'Bearer t'),
    );

    expect(error.code).toBe('REQ_STEP_INVALID');
  });

  it('refuses someone who is not carrying the request', async () => {
    const { service, moves } = serviceWith({ request: onStep('DOCS') });

    await expect(
      service.advance(
        'req-1',
        { to_step: 'INSTALL' },
        principal('user-bystander'),
        'Bearer t',
      ),
    ).rejects.toThrow(AppError);
    expect(moves).toHaveLength(0);
  });

  it('answers NOT_FOUND for a request in another company', async () => {
    const { service } = serviceWith({ request: onStep('DOCS') });

    const error = await refused(
      service.advance(
        'req-1',
        { to_step: 'INSTALL' },
        principal(WORKER, 'company-other'),
        'Bearer t',
      ),
    );

    expect(error.code).toBe('NOT_FOUND');
  });
});

describe('request flow: complete finishes only from the last step', () => {
  it('refuses to complete from a step that still has a way forward', async () => {
    const { service, statusWrites } = serviceWith({ request: onStep('DOCS') });

    const error = await refused(
      service.complete('req-1', principal(), 'Bearer t'),
    );

    expect(error.code).toBe('REQ_STEP_INVALID');
    expect(statusWrites).toHaveLength(0);
  });

  it('completes from the last step', async () => {
    const { service, statusWrites } = serviceWith({
      request: onStep('TEST'),
      hasLadder: false,
    });

    await service.complete('req-1', principal(), 'Bearer t');

    expect(statusWrites[0]).toBe('completed');
  });
});
