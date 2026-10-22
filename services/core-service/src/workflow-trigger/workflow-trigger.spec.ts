import { sealSecret } from '../pm/config-rules';
import { WorkflowStartError } from '../workflow/workflow-client';
import { WorkflowTriggerAdminService } from './workflow-trigger-admin.service';
import { WorkflowTriggerDispatchService } from './workflow-trigger-dispatch.service';
import {
  matchesTypes,
  sampleVariables,
  startOf,
  triggerProblems,
  TRIGGER_EVENT_KEYS,
} from './workflow-trigger-rules';

const SECRET = 'test-config-secret';
const CHANNEL = 'cmvhx4s5c05cl97016ttnrkj3';

const actor = {
  userId: 'admin-1',
  activeCompanyId: 'osd',
  permissions: ['admin.integration.manage'],
} as never;

function config(values: Record<string, unknown> = {}) {
  const all: Record<string, unknown> = {
    'projectConfig.secret': SECRET,
    'workflowTrigger.intervalMs': 0,
    'workflow.organizationId': 'osd',
    'workflow.workspaceId': 'default',
    ...values,
  };
  return { get: jest.fn((key: string) => all[key]) };
}

const trigger = (over: Record<string, unknown> = {}) => ({
  id: 'trg-1',
  companyId: 'osd',
  name: 'Lead ใหม่ → ขั้นที่ 1',
  eventKey: 'lead.created',
  typeCodes: [] as string[],
  channelId: CHANNEL,
  channelKeyEnc: sealSecret('osdwf_channel_key', SECRET),
  organizationId: 'osd',
  workspaceId: 'default',
  active: true,
  createdBy: 'admin-1',
  createdAt: new Date('2026-10-22T03:00:00Z'),
  ...over,
});

describe('workflow trigger rules', () => {
  it('round 1 listens only to events that are domain events already', () => {
    expect(TRIGGER_EVENT_KEYS).toEqual(
      expect.arrayContaining([
        'lead.created',
        'lead.converted',
        'request.submitted',
        'esign.completed',
      ]),
    );
  });

  it('lead.created sends what LeadWorkflowSyncService always sent, "-" for none', () => {
    expect(
      startOf({
        name: 'lead.created',
        payload: {
          company_id: 'osd',
          lead_id: 'l-1',
          name: '',
          status: 'new',
          source_code: null,
        },
      }),
    ).toEqual({
      resourceType: 'lead',
      resourceId: 'l-1',
      variables: { leadId: 'l-1', leadName: '-', companyId: 'osd' },
    });
  });

  it('a request trigger narrowed to some types counts only those; none = all', () => {
    expect(matchesTypes([], { type_code: 'SOL' })).toBe(true);
    expect(matchesTypes(['SOL'], { type_code: 'SOL' })).toBe(true);
    expect(matchesTypes(['SOL'], { type_code: 'FI05' })).toBe(false);
  });

  it('refuses an unknown event, a type filter on a non-request event, a malformed channel', () => {
    expect(triggerProblems({ eventKey: 'nope' })[0].field).toBe('event_key');
    expect(
      triggerProblems({ eventKey: 'lead.created', typeCodes: ['SOL'] })[0]
        .field,
    ).toBe('type_codes');
    expect(triggerProblems({ channelId: 'https://x/y' })[0].field).toBe(
      'channel_id',
    );
    expect(
      triggerProblems({
        eventKey: 'request.submitted',
        typeCodes: ['SOL'],
        channelId: CHANNEL,
      }),
    ).toEqual([]);
  });

  it('test variables name every variable the event sends', () => {
    expect(sampleVariables('request.submitted', 'osd')).toEqual({
      requestId: 'TEST-requestId',
      requestNo: 'TEST-requestNo',
      typeCode: 'TEST-typeCode',
      companyId: 'osd',
    });
  });
});

function dispatch(options: { triggers?: unknown[]; startFails?: Error } = {}) {
  const triggers = {
    listeningTo: jest.fn(() =>
      Promise.resolve(options.triggers ?? [{ id: 'trg-1', typeCodes: [] }]),
    ),
    findUnique: jest.fn(() => Promise.resolve(trigger())),
    findFirst: jest.fn(() => Promise.resolve(null)),
  };
  const starts = {
    createMany: jest.fn((args: { data: unknown[] }) =>
      Promise.resolve({ count: args.data.length }),
    ),
    claimDue: jest.fn(),
    update: jest.fn(() => Promise.resolve({})),
  };
  const leads = { updateMany: jest.fn(() => Promise.resolve({ count: 1 })) };
  const events = { on: jest.fn() };
  const workflow = {
    start: jest.fn(() =>
      options.startFails
        ? Promise.reject(options.startFails)
        : Promise.resolve({
            instanceId: 'wfi-9',
            workflowKey: 'ctd-flow-s1',
            status: 'ACTIVE',
          }),
    ),
  };
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const service = new WorkflowTriggerDispatchService(
    triggers as never,
    starts as never,
    leads as never,
    events as never,
    workflow as never,
    audit as never,
    config() as never,
  );
  return { service, triggers, starts, leads, events, workflow, audit };
}

const claimed = (over: Record<string, unknown> = {}) => ({
  id: 'st-1',
  triggerId: 'trg-1',
  companyId: 'osd',
  eventKey: 'lead.created',
  resourceType: 'lead',
  resourceId: 'l-1',
  variables: { leadId: 'l-1', leadName: 'ACME', companyId: 'osd' },
  attempts: 1,
  ...over,
});

describe('WorkflowTriggerDispatchService', () => {
  it('subscribes to every event in the catalogue', () => {
    const { service, events } = dispatch();
    service.onModuleInit();
    expect(events.on).toHaveBeenCalledTimes(TRIGGER_EVENT_KEYS.length);
  });

  it('queues one start per active trigger of the company, never twice for one document', async () => {
    const { service, triggers, starts } = dispatch();
    await expect(
      service.enqueue({
        name: 'lead.created',
        payload: {
          company_id: 'osd',
          lead_id: 'l-1',
          name: 'ACME',
          status: 'new',
          source_code: null,
        },
      }),
    ).resolves.toBe(1);
    expect(triggers.listeningTo).toHaveBeenCalledWith('osd', 'lead.created');
    expect(starts.createMany).toHaveBeenCalledWith({
      data: [
        {
          triggerId: 'trg-1',
          companyId: 'osd',
          eventKey: 'lead.created',
          resourceType: 'lead',
          resourceId: 'l-1',
          variables: { leadId: 'l-1', leadName: 'ACME', companyId: 'osd' },
        },
      ],
      skipDuplicates: true,
    });
  });

  it('a request of a type the trigger does not count queues nothing', async () => {
    const { service, starts } = dispatch({
      triggers: [{ id: 'trg-2', typeCodes: ['SOL'] }],
    });
    await expect(
      service.enqueue({
        name: 'request.submitted',
        payload: {
          company_id: 'osd',
          request_id: 'r-1',
          request_no: 'REQ-1',
          type_code: 'FI05',
          requester_id: 'u',
        },
      }),
    ).resolves.toBe(0);
    expect(starts.createMany).not.toHaveBeenCalled();
  });

  it('starts with the opened key, keeps the instance on the start and on the lead, audits it', async () => {
    const { service, starts, workflow, leads, audit } = dispatch();
    starts.claimDue.mockResolvedValue([claimed()]);

    await expect(service.sweep()).resolves.toBe(1);

    expect(workflow.start).toHaveBeenCalledWith(
      {
        channelId: CHANNEL,
        channelKey: 'osdwf_channel_key',
        organizationId: 'osd',
        workspaceId: 'default',
      },
      { leadId: 'l-1', leadName: 'ACME', companyId: 'osd' },
    );
    expect(starts.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'st-1' },
        data: expect.objectContaining({
          status: 'started',
          instanceId: 'wfi-9',
        }),
      }),
    );
    expect(leads.updateMany).toHaveBeenCalledWith({
      where: { id: 'l-1', companyId: 'osd', workflowInstanceId: null },
      data: { workflowInstanceId: 'wfi-9' },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'integration.workflow.started',
        actorId: null,
      }),
    );
  });

  it('a refused start goes back on the queue with its status code, then dies on the last attempt', async () => {
    const { service, starts } = dispatch({
      startFails: new WorkflowStartError(401, 'HTTP 401'),
    });
    starts.claimDue.mockResolvedValue([claimed()]);
    await service.sweep();
    expect(starts.update).toHaveBeenLastCalledWith({
      where: { id: 'st-1' },
      data: expect.objectContaining({
        status: 'pending',
        lastStatusCode: 401,
        lastError: 'HTTP 401',
      }),
    });

    starts.claimDue.mockResolvedValue([claimed({ attempts: 6 })]);
    await service.sweep();
    expect(starts.update).toHaveBeenLastCalledWith({
      where: { id: 'st-1' },
      data: expect.objectContaining({ status: 'dead', lastStatusCode: 401 }),
    });
  });

  it('a key that no longer opens (CONFIG_SECRET_KEY changed) is dead at once', async () => {
    const { service, starts, triggers, workflow } = dispatch();
    triggers.findUnique.mockResolvedValue(
      trigger({ channelKeyEnc: sealSecret('k', 'another-secret') }),
    );
    starts.claimDue.mockResolvedValue([claimed()]);
    await service.sweep();
    expect(workflow.start).not.toHaveBeenCalled();
    expect(starts.update).toHaveBeenLastCalledWith({
      where: { id: 'st-1' },
      data: expect.objectContaining({ status: 'dead' }),
    });
  });
});

function admin(found: unknown = trigger()) {
  const triggers = {
    findMany: jest.fn(() => Promise.resolve([found])),
    findFirst: jest.fn(() => Promise.resolve(found)),
    create: jest.fn((args: { data: Record<string, unknown> }) =>
      Promise.resolve({ ...trigger(), ...args.data, id: 'trg-new' }),
    ),
    update: jest.fn((args: { data: Record<string, unknown> }) =>
      Promise.resolve({
        ...trigger(),
        ...Object.fromEntries(
          Object.entries(args.data).filter(([, v]) => v !== undefined),
        ),
      }),
    ),
  };
  const starts = {
    findFirst: jest.fn(() => Promise.resolve(null)),
    findMany: jest.fn(() => Promise.resolve([])),
    create: jest.fn((args: { data: Record<string, unknown> }) =>
      Promise.resolve({
        id: 'st-t',
        status: 'pending',
        attempts: 0,
        lastStatusCode: null,
        lastError: null,
        instanceId: null,
        workflowKey: null,
        nextAttemptAt: new Date(),
        startedAt: null,
        createdAt: new Date(),
        ...args.data,
      }),
    ),
    update: jest.fn(),
  };
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const service = new WorkflowTriggerAdminService(
    triggers as never,
    starts as never,
    audit as never,
    config() as never,
  );
  return { service, triggers, starts, audit };
}

describe('WorkflowTriggerAdminService', () => {
  it('seals the channel key; neither the row, the answer nor audit carries it', async () => {
    const { service, triggers, audit } = admin();
    const row = await service.create(
      {
        name: ' Lead → s1 ',
        event_key: 'lead.created',
        channel_id: CHANNEL,
        channel_key: ' osdwf_secret ',
      },
      actor,
    );

    const data = (
      triggers.create.mock.calls[0] as unknown as [
        { data: Record<string, unknown> },
      ]
    )[0].data;
    expect(data.channelKeyEnc).not.toContain('osdwf_secret');
    expect(data.companyId).toBe('osd');
    expect(data.organizationId).toBe('osd');
    expect(JSON.stringify(row)).not.toContain('osdwf_secret');
    expect(row.has_channel_key).toBe(true);
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain(
      'osdwf_secret',
    );
  });

  it("SCOPE-03 — another company's trigger answers 404", async () => {
    const { service, triggers } = admin(null);
    await expect(
      service.update('trg-x', { active: false }, actor),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(triggers.findFirst).toHaveBeenCalledWith({
      where: { id: 'trg-x', companyId: 'osd' },
    });
  });

  it('refuses a type filter on a lead event', async () => {
    const { service } = admin();
    await expect(
      service.create(
        {
          name: 'x',
          event_key: 'lead.created',
          type_codes: ['SOL'],
          channel_id: CHANNEL,
          channel_key: 'k',
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('a new key is audited as a rotation; no key keeps the old one', async () => {
    const { service, triggers, audit } = admin();
    await service.update('trg-1', { name: 'ใหม่' }, actor);
    expect(
      (
        triggers.update.mock.calls[0] as unknown as [
          { data: Record<string, unknown> },
        ]
      )[0].data.channelKeyEnc,
    ).toBeUndefined();
    await service.update('trg-1', { channel_key: 'rotated' }, actor);
    expect(audit.record).toHaveBeenLastCalledWith(
      expect.objectContaining({
        eventType: 'admin.workflow_trigger.key_rotated',
      }),
    );
  });

  it('test queues one real start with sample variables, and a closed trigger cannot be tested', async () => {
    const { service, starts } = admin();
    const row = await service.test('trg-1', actor);
    expect(row.resource_type).toBe('test');
    expect(starts.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        variables: {
          leadId: 'TEST-leadId',
          leadName: 'TEST-leadName',
          companyId: 'osd',
        },
      }),
    });

    const closed = admin(trigger({ active: false }));
    await expect(closed.service.test('trg-1', actor)).rejects.toMatchObject({
      code: 'UNPROCESSABLE',
    });
  });
});
