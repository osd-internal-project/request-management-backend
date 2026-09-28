import { AppError } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { RequestsService } from './requests.service';
import {
  assertUsableSubRequestTypes,
  missingRequiredSubRequests,
} from './submit-rules';

const OSD = 'company-osd';
const WORKER = 'user-worker';

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    userId: WORKER,
    activeCompanyId: OSD,
    username: 'worker',
    orgUnitId: null,
    permissions: ['request.complete', 'request.create'],
    ...overrides,
    // Only the fields these paths read.
  } as unknown as Principal;
}

const CHECKLIST = [
  { code: 'IT_ACCOUNT', name: 'เปิดบัญชี IT', required: true },
  { code: 'EQUIP', name: 'ขออุปกรณ์', required: false },
];

function inProgressRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: 'req-1',
    requestNo: 'OSD-ONB-202609-0001',
    companyId: OSD,
    typeCode: 'ONB',
    status: 'in_progress',
    requesterId: 'user-requester',
    receiverUserId: WORKER,
    assigneeUserId: null,
    formData: {},
    typeSnapshot: { code: 'ONB', subRequestTypes: CHECKLIST },
    requestType: { approvalPolicy: {}, subRequestTypes: [] },
    attachments: [],
    ...overrides,
  };
}

function serviceWith(options: {
  request?: Record<string, unknown> | null;
  children?: { typeCode: string; status: string }[];
  referencingTypes?: { code: string }[];
}) {
  const updates: Record<string, unknown>[] = [];
  const prisma = {
    request: {
      update: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        return Promise.resolve({ id: 'req-1', ...data });
      }),
    },
    // `nextRequestEventSeq` locks the row, then reads the last seq.
    $queryRaw: jest.fn(() => Promise.resolve([])),
    requestEvent: {
      findFirst: jest.fn(() => Promise.resolve(null)),
      create: jest.fn(() => Promise.resolve({})),
    },
    requestType: { delete: jest.fn(() => Promise.resolve({})) },
  };
  const typesFindMany = jest.fn<
    Promise<unknown[]>,
    [{ where: Record<string, unknown> }]
  >(() => Promise.resolve(options.referencingTypes ?? []));

  const service = new RequestsService(
    {
      findWithType: jest.fn(() =>
        Promise.resolve(
          options.request === undefined ? inProgressRequest() : options.request,
        ),
      ),
      findOpenChildren: jest.fn(() => Promise.resolve([])),
      findChildTypes: jest.fn(() => Promise.resolve(options.children ?? [])),
      countWhere: jest.fn(() => Promise.resolve(0)),
    } as never,
    {} as never,
    {} as never,
    {
      findMany: typesFindMany,
      findFirst: jest.fn(() =>
        Promise.resolve({ id: 'type-eq', code: 'EQUIP', name: 'ขออุปกรณ์' }),
      ),
    } as never,
    { ancestorIdsOf: jest.fn(() => Promise.resolve([])) } as never,
    {} as never,
    {
      hasPublishedMatrix: jest.fn(() => Promise.resolve(false)),
      countMatricesFor: jest.fn(() => Promise.resolve(0)),
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
    {} as never, // flows
  );

  return { service, updates, typesFindMany };
}

describe('sub-request checklist: what an admin may save', () => {
  const known = ['IT_ACCOUNT', 'EQUIP'];

  it('accepts distinct codes that exist', () => {
    expect(() =>
      assertUsableSubRequestTypes(
        'ONB',
        [
          { code: 'IT_ACCOUNT', required: true },
          { code: 'EQUIP', required: false },
        ],
        known,
      ),
    ).not.toThrow();
  });

  it.each([
    ['itself', [{ code: 'ONB', required: true }], 'อ้างถึงตัวเอง: ONB'],
    [
      'a repeated code',
      [
        { code: 'EQUIP', required: true },
        { code: 'EQUIP', required: false },
      ],
      'ประเภทซ้ำ: EQUIP',
    ],
    [
      'an unknown code',
      [{ code: 'NOPE', required: true }],
      'ไม่พบประเภท: NOPE',
    ],
  ])('refuses %s', (_label, items, reason) => {
    expect.assertions(2);
    try {
      assertUsableSubRequestTypes('ONB', items, known);
    } catch (error) {
      expect((error as AppError).code).toBe('VALIDATION_FAILED');
      expect((error as AppError).details).toContainEqual({
        field: 'sub_request_types',
        reason,
      });
    }
  });
});

describe('sub-request checklist: which required items are still missing', () => {
  it('ignores optional items and counts any child that was not cancelled', () => {
    expect(
      missingRequiredSubRequests(CHECKLIST, [
        { typeCode: 'IT_ACCOUNT', status: 'closed' },
      ]),
    ).toEqual([]);
  });

  it('does not count a cancelled child', () => {
    expect(
      missingRequiredSubRequests(CHECKLIST, [
        { typeCode: 'IT_ACCOUNT', status: 'cancelled' },
      ]),
    ).toEqual(['IT_ACCOUNT']);
  });
});

describe('sub-request checklist: complete waits for the required items', () => {
  it('refuses with REQ_SUB_REQUEST_MISSING and writes nothing', async () => {
    expect.assertions(3);
    const { service, updates } = serviceWith({ children: [] });

    try {
      await service.complete('req-1', principal(), 'Bearer token');
    } catch (error) {
      expect((error as AppError).code).toBe('REQ_SUB_REQUEST_MISSING');
      expect((error as AppError).details).toEqual([
        { field: 'sub_request_types', reason: 'IT_ACCOUNT' },
      ]);
    }
    expect(updates).toHaveLength(0);
  });

  it('completes once every required item has a child', async () => {
    const { service, updates } = serviceWith({
      children: [{ typeCode: 'IT_ACCOUNT', status: 'closed' }],
    });

    await service.complete('req-1', principal(), 'Bearer token');

    expect(updates.map((update) => update.status)).toEqual([
      'completed',
      'approved',
    ]);
  });

  /** REQ-01: a checklist added to the type after submit does not reach this request. */
  it('reads the snapshot, not a type edited later', async () => {
    const { service, updates } = serviceWith({
      request: inProgressRequest({
        typeSnapshot: { code: 'ONB' },
        requestType: {
          approvalPolicy: {},
          subRequestTypes: [{ code: 'IT_ACCOUNT', required: true }],
        },
      }),
    });

    await service.complete('req-1', principal(), 'Bearer token');

    expect(updates[0].status).toBe('completed');
  });

  it('refuses someone who is not carrying the request', async () => {
    const { service, updates } = serviceWith({
      children: [{ typeCode: 'IT_ACCOUNT', status: 'closed' }],
    });

    await expect(
      service.complete(
        'req-1',
        principal({ userId: 'user-bystander' }),
        'Bearer token',
      ),
    ).rejects.toThrow(AppError);
    expect(updates).toHaveLength(0);
  });
});

describe('sub-request checklist: raising one from the parent', () => {
  it('offers the checklist types regardless of group eligibility', async () => {
    const { service, typesFindMany } = serviceWith({});

    await service.listTypes(principal(), 'req-1');

    const where = typesFindMany.mock.calls[0][0].where as {
      OR: Record<string, unknown>[];
    };
    expect(where.OR).toContainEqual({
      code: { in: ['IT_ACCOUNT', 'EQUIP'] },
    });
  });

  it('answers NOT_FOUND for a parent in another company', async () => {
    const { service, typesFindMany } = serviceWith({
      request: inProgressRequest({ companyId: 'company-other' }),
    });

    await expect(service.listTypes(principal(), 'req-1')).rejects.toMatchObject(
      { code: 'NOT_FOUND' },
    );
    expect(typesFindMany).not.toHaveBeenCalled();
  });
});

describe('sub-request checklist: a referenced type cannot be deleted', () => {
  it('names the parent type that lists it', async () => {
    expect.assertions(2);
    const { service } = serviceWith({ referencingTypes: [{ code: 'ONB' }] });

    try {
      await service.deleteType('EQUIP', principal());
    } catch (error) {
      expect((error as AppError).code).toBe('REQ_TYPE_IN_USE');
      expect((error as AppError).details).toContainEqual({
        field: 'sub_request_types',
        reason: 'เป็นคำขอย่อยของ ONB',
      });
    }
  });
});
