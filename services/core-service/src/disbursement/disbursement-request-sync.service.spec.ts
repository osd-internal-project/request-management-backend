import { FormBindingRegistry } from '../requests/form-binding.registry';
import { DisbursementRequestSyncService } from './disbursement-request-sync.service';

const REQUEST = {
  id: 'req-1',
  companyId: 'osd',
  requestNo: 'REQ-OSD-FI05-26090012',
  typeCode: 'FI05',
  status: 'pending_approval',
  requesterId: 'may',
  requesterOrgUnitId: 'mkt',
  formData: {
    payee: 'เมย์',
    cost_center: '2002',
    purpose: 'ออกบูธ Thailand Retail Expo 2026',
    needed_by: '2026-09-05',
    clear_by: '2026-09-15',
    expense_items: [
      { description: 'ค่าเดินทาง', cost_center: '2002', amount: 6000 },
      { description: 'ค่าที่พัก 2 คืน', cost_center: '2002', amount: 5000 },
      { description: 'เบ็ดเตล็ด', cost_center: '2002', amount: 4000 },
    ],
  },
};

function harness(
  existing: Record<string, unknown> | null = null,
  request: Record<string, unknown> = REQUEST,
) {
  const guards: Record<
    string,
    (r: { id: string; companyId?: string }, move?: unknown) => Promise<void>
  > = {};
  const handlers: Record<string, (e: { payload: unknown }) => Promise<void>> =
    {};
  const tx = {
    disbursement: {
      create: jest.fn(() =>
        Promise.resolve({ id: 'd-1', requestedAmount: '15000.00' }),
      ),
      update: jest.fn(() => Promise.resolve({})),
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
    },
    disbursementLine: { deleteMany: jest.fn(() => Promise.resolve({})) },
  };
  const disbursements = {
    findFirst: jest.fn(() => Promise.resolve(existing)),
    count: jest.fn(() => Promise.resolve(0)),
  };
  const settings = {
    findFirst: jest.fn(() =>
      Promise.resolve({
        advanceTypeCode: 'FI05',
        pettyCashTypeCode: 'FI06',
        verifyStep: 'VERIFY',
        execStep: 'EXEC',
        payStep: 'PAY',
        clearStep: 'CLEAR',
        doneStep: 'DONE',
      }),
    ),
    findMany: jest.fn(() =>
      Promise.resolve([{ advanceTypeCode: 'FI05', pettyCashTypeCode: 'FI06' }]),
    ),
  };
  const requests = {
    addGuard: jest.fn(
      (
        name: string,
        fn: (r: { id: string; companyId?: string }, move?: unknown) => Promise<void>,
      ) => {
        guards[name] = fn;
      },
    ),
  };
  const runNumbers = {
    issueUnused: jest.fn(() => Promise.resolve('ADV-OSD-2026-00007')),
  };
  const events = {
    on: jest.fn((name: string, fn: (e: { payload: unknown }) => Promise<void>) => {
      handlers[name] = fn;
    }),
  };
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const bindings = new FormBindingRegistry();
  const service = new DisbursementRequestSyncService(
    disbursements as never,
    settings as never,
    { findFirst: jest.fn(() => Promise.resolve(request)) } as never,
    requests as never,
    runNumbers as never,
    events as never,
    audit as never,
    { execute: jest.fn((work: (p: unknown) => unknown) => work(tx)) } as never,
    bindings,
  );
  service.onModuleInit();
  return { service, tx, guards, handlers, runNumbers, settings, audit, bindings };
}

const createData = (tx: ReturnType<typeof harness>['tx']) =>
  (tx.disbursement.create.mock.calls[0] as unknown as [
    { data: Record<string, unknown> },
  ])[0].data;

describe('disbursement ↔ request sync', () => {
  it('a sent FI05 becomes an advance waiting for the head, totalled from its form', async () => {
    const { handlers, tx, runNumbers, audit } = harness();
    await handlers['request.submitted']({ payload: { request_id: 'req-1' } });

    expect(runNumbers.issueUnused).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 'osd', docType: 'ADVANCE' }),
      expect.any(Function),
    );
    const data = createData(tx);
    expect(data).toMatchObject({
      docNo: 'ADV-OSD-2026-00007',
      kind: 'ADVANCE',
      requestId: 'req-1',
      status: 'PENDING_HEAD',
      requestedAmount: '15000.00',
      costCenter: '2002',
    });
    expect(
      (data.lines as { create: unknown[] }).create,
    ).toHaveLength(3);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'disbursement.created' }),
      { prisma: tx },
    );
  });

  it('ignores a request type the company has not mapped', async () => {
    const { handlers, tx, settings } = harness();
    settings.findFirst.mockResolvedValueOnce({
      advanceTypeCode: 'FI99',
      pettyCashTypeCode: 'FI98',
      verifyStep: 'VERIFY',
      execStep: 'EXEC',
      payStep: 'PAY',
      clearStep: 'CLEAR',
        doneStep: 'DONE',
    });
    await handlers['request.submitted']({ payload: { request_id: 'req-1' } });
    expect(tx.disbursement.create).not.toHaveBeenCalled();
  });

  it('does not create a second disbursement for the same request', async () => {
    const { handlers, tx } = harness({
      id: 'd-1',
      companyId: 'osd',
      docNo: 'ADV-OSD-2026-00007',
      status: 'PAID',
    });
    await handlers['request.submitted']({ payload: { request_id: 'req-1' } });
    expect(tx.disbursement.create).not.toHaveBeenCalled();
    expect(tx.disbursement.update).not.toHaveBeenCalled();
  });

  it('the head approving the request hands the disbursement to accounting', async () => {
    const { handlers, tx } = harness({
      id: 'd-1',
      companyId: 'osd',
      docNo: 'ADV-OSD-2026-00007',
      status: 'PENDING_HEAD',
    });
    await handlers['request.pre_approved']({
      payload: { request_id: 'req-1' },
    });
    expect(tx.disbursement.updateMany).toHaveBeenCalledWith({
      where: { id: 'd-1', status: 'PENDING_HEAD' },
      data: { status: 'PENDING_VERIFY' },
    });
  });

  it('follows the ticket onto the executive step', async () => {
    const { handlers, tx } = harness({
      id: 'd-1',
      companyId: 'osd',
      docNo: 'ADV-OSD-2026-00007',
      kind: 'ADVANCE',
      status: 'PENDING_VERIFY',
    });
    await handlers['request.step.entered']({
      payload: { request_id: 'req-1', step_code: 'EXEC', status: 'pending_approval' },
    });
    expect(tx.disbursement.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'd-1', status: 'PENDING_VERIFY' },
        data: { status: 'PENDING_EXEC' },
      }),
    );
  });

  it('holds the ticket at the pay step until the money is out', async () => {
    const approved = harness({
      id: 'd-1',
      companyId: 'osd',
      docNo: 'ADV-1',
      kind: 'ADVANCE',
      status: 'APPROVED',
      verifiedAt: new Date(),
    });
    await expect(
      approved.guards.advance(
        { id: 'req-1', companyId: 'osd' },
        { from: 'PAY', to: 'CLEAR', backward: false },
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const paid = harness({
      id: 'd-1',
      companyId: 'osd',
      docNo: 'ADV-1',
      kind: 'ADVANCE',
      status: 'PAID',
      verifiedAt: new Date(),
    });
    await expect(
      paid.guards.advance(
        { id: 'req-1', companyId: 'osd' },
        { from: 'PAY', to: 'CLEAR', backward: false },
      ),
    ).resolves.toBeUndefined();
  });

  it('holds the request at complete until the disbursement is closed', async () => {
    const open = harness({ id: 'd-1', docNo: 'ADV-1', status: 'CLEARING' });
    await expect(open.guards.complete({ id: 'req-1' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    const closed = harness({ id: 'd-1', docNo: 'ADV-1', status: 'CLOSED' });
    await expect(closed.guards.complete({ id: 'req-1' })).resolves.toBeUndefined();
    const none = harness(null);
    await expect(none.guards.complete({ id: 'req-1' })).resolves.toBeUndefined();
  });

  it('refuses to cancel the request once money is out', async () => {
    const paid = harness({ id: 'd-1', docNo: 'ADV-1', status: 'PAID' });
    await expect(paid.guards.cancel({ id: 'req-1' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    const approved = harness({ id: 'd-1', docNo: 'ADV-1', status: 'APPROVED' });
    await expect(approved.guards.cancel({ id: 'req-1' })).resolves.toBeUndefined();
  });
});

/** FI05 on the v3 flow: asked and approved on the request, no money step. */
const V3_REQUEST = {
  ...REQUEST,
  status: 'in_progress',
  currentStepCode: 'DISBURSE',
  flowVersionId: 'flow-v3',
  stepFormData: {
    VERIFY: { checked_cost_center: true, checked_documents: true, checked_authority: true, note: 'ครบ' },
  },
  flowVersion: {
    steps: [
      {
        code: 'REQUEST',
        scopeStatus: 'draft',
        formSchema: {
          type: 'object',
          properties: {
            objective: { type: 'string', 'x-bind': 'disbursement.purpose' },
            items: {
              type: 'array',
              'x-bind': 'disbursement.lines',
              items: {
                type: 'object',
                properties: {
                  what: { type: 'string', 'x-bind': 'disbursement.lines.description' },
                  baht: { type: 'number', 'x-bind': 'disbursement.lines.amount' },
                },
              },
            },
          },
        },
      },
      { code: 'HEAD', scopeStatus: 'pending_approval', formSchema: null },
      { code: 'EXEC', scopeStatus: 'pending_approval', formSchema: null },
      { code: 'RECEIVE', scopeStatus: 'submitted', formSchema: null },
      { code: 'DISBURSE', scopeStatus: 'in_progress', formSchema: null },
      { code: 'DONE', scopeStatus: 'approved', formSchema: null },
    ],
  },
  formData: { objective: 'ออกบูธ', items: [{ what: 'ค่ารถ', baht: 600 }, { what: 'ที่พัก', baht: 1400 }] },
  stepRuns: [{ heldBy: 'acc-1', leftAt: new Date('2026-10-06T03:00:00Z') }],
};

const enterWork = { payload: { request_id: 'req-1', step_code: 'DISBURSE', status: 'in_progress' } };

describe('disbursement v3 — created when accounting has received the approved request', () => {
  it('does not create anything when a v3 request is only sent', async () => {
    const { handlers, tx } = harness(null, { ...V3_REQUEST, status: 'pending_approval' });
    await handlers['request.submitted']({ payload: { request_id: 'req-1' } });
    expect(tx.disbursement.create).not.toHaveBeenCalled();
  });

  it('entering the work step creates it waiting for accounting’s check, read through x-bind', async () => {
    const { handlers, tx } = harness(null, V3_REQUEST);
    await handlers['request.step.entered'](enterWork);
    const data = createData(tx);
    expect(data).toMatchObject({ status: 'PENDING_VERIFY', purpose: 'ออกบูธ', requestedAmount: '2000.00' });
    expect(data.sourceSnapshot).toMatchObject({ flowVersionId: 'flow-v3', formData: V3_REQUEST.formData });
  });

  it('creates nothing at the earlier steps (head, executive, receive)', async () => {
    const { handlers, tx } = harness(null, { ...V3_REQUEST, status: 'submitted', currentStepCode: 'RECEIVE' });
    await handlers['request.step.entered']({ payload: { request_id: 'req-1', step_code: 'RECEIVE', status: 'submitted' } });
    expect(tx.disbursement.create).not.toHaveBeenCalled();
  });

  it('holds the request at the work step until the disbursement is closed', async () => {
    const open = harness({ id: 'd-1', docNo: 'ADV-1', kind: 'ADVANCE', status: 'PAID' }, V3_REQUEST);
    await expect(
      open.guards.advance({ id: 'req-1', companyId: 'osd' }, { from: 'DISBURSE', backward: false }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const closed = harness({ id: 'd-1', docNo: 'ADV-1', kind: 'ADVANCE', status: 'CLOSED' }, V3_REQUEST);
    await expect(
      closed.guards.advance({ id: 'req-1', companyId: 'osd' }, { from: 'DISBURSE', backward: false }),
    ).resolves.toBeUndefined();
  });

  it('leaves a request on the old flow (with a pay step) to the submit-time path', async () => {
    const legacy = {
      ...V3_REQUEST,
      flowVersion: { steps: [...V3_REQUEST.flowVersion.steps, { code: 'PAY', scopeStatus: 'in_progress', formSchema: null }] },
    };
    const { handlers, tx } = harness(null, legacy);
    await handlers['request.step.entered'](enterWork);
    expect(tx.disbursement.create).not.toHaveBeenCalled();
  });

  it('ignores a request of a type that is not mapped to a disbursement', async () => {
    const { handlers, tx } = harness(null, { ...V3_REQUEST, typeCode: 'PS01' });
    await handlers['request.step.entered'](enterWork);
    expect(tx.disbursement.create).not.toHaveBeenCalled();
  });

  it('from-request answers with the existing disbursement instead of a second one', async () => {
    const { service, tx } = harness({ id: 'd-1', docNo: 'ADV-1', status: 'APPROVED' }, V3_REQUEST);
    await expect(service.createFromRequest('req-1')).resolves.toEqual({ docNo: 'ADV-1', created: false });
    expect(tx.disbursement.create).not.toHaveBeenCalled();
  });

  it('from-request refuses a request the executive has not approved yet', async () => {
    const { service } = harness(null, { ...V3_REQUEST, status: 'pending_approval', currentStepCode: 'EXEC' });
    await expect(service.createFromRequest('req-1')).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('registers FI05 / FI06 so a form that drops the amount column cannot be saved', async () => {
    const { bindings } = harness();
    await expect(
      bindings.assertBound('FI05', { type: 'object', properties: {} }, 'osd'),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(bindings.assertBound('PS01', { type: 'object', properties: {} }, 'osd')).resolves.toBeUndefined();
  });
});
