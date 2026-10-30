import {
  ALL_PERMISSIONS,
  AUTHENTICATED_KEY,
  PERMISSIONS_KEY,
} from '@request-management/share';
import { lastValueFrom, toArray } from 'rxjs';
import { AGENT_ACTIONS, readableActions } from './agent-actions';
import {
  AgentRecordsController,
  LeadFindController,
} from './agent-records.controller';
import { AgentRecordsService } from './agent-records.service';
import { VuvagentDispatchError } from './vuvagent.client';

/** The decorated method itself — where `SetMetadata` writes on a route. */
function handler(proto: object, name: string): object {
  const value: unknown = Object.getOwnPropertyDescriptor(proto, name)?.value;
  return typeof value === 'function' ? value : {};
}

const seller = {
  userId: 'u-1',
  activeCompanyId: 'osd',
  ledUnitIds: [],
  scopedUnitIds: [],
  permissions: ['crm.sales.read', 'crm.sales.manage'],
} as never;

const outsider = {
  userId: 'u-2',
  activeCompanyId: 'osd',
  ledUnitIds: [],
  scopedUnitIds: [],
  permissions: ['request.read'],
} as never;

function setup() {
  const records = {
    findMany: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
    findFirst: jest.fn().mockResolvedValue(null),
    update: jest.fn((args: { data: unknown }) =>
      Promise.resolve({ id: 'rec-1', ...(args.data as object) }),
    ),
  };
  const tx = {
    agentRecord: {
      create: jest.fn().mockResolvedValue({ id: 'rec-1' }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirst: jest.fn().mockResolvedValue({ id: 'rec-1', status: 'done' }),
    },
  };
  const transactions = {
    execute: jest.fn((work: (client: typeof tx) => unknown) => work(tx)),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const members = {
    displayNamesOf: jest.fn().mockResolvedValue(new Map([['u-1', 'สมชาย']])),
  };
  const leads = { findMany: jest.fn().mockResolvedValue([]) };
  const vuvagent = {
    mode: 'mock',
    dispatch: jest.fn().mockResolvedValue(undefined),
  };

  const service = new AgentRecordsService(
    records as never,
    leads as never,
    members as never,
    audit as never,
    transactions as never,
    vuvagent as never,
  );
  return { service, records, tx, audit, leads, vuvagent };
}

describe('AGENT_ACTIONS', () => {
  it('names only permissions that exist in the catalog', () => {
    for (const rights of Object.values(AGENT_ACTIONS)) {
      expect(ALL_PERMISSIONS).toContain(rights.read);
      expect(ALL_PERMISSIONS).toContain(rights.start);
    }
  });

  it('a caller without crm.sales.read can read no lead.find record', () => {
    expect(readableActions(seller)).toEqual(['lead.find']);
    expect(readableActions(outsider)).toEqual([]);
  });
});

describe('route gates', () => {
  it('find leads needs the start right of lead.find', () => {
    expect(
      Reflect.getMetadata(
        PERMISSIONS_KEY,
        handler(LeadFindController.prototype, 'find'),
      ),
    ).toEqual(['crm.sales.manage']);
  });

  it('reads are authenticated and filtered per action in the service', () => {
    for (const name of ['list', 'stream', 'findOne']) {
      expect(
        Reflect.getMetadata(
          AUTHENTICATED_KEY,
          handler(AgentRecordsController.prototype, name),
        ),
      ).toBe(true);
    }
  });
});

describe('AgentRecordsService.findLeads', () => {
  it('commits record + audit, then hands the agent the record id and topic', async () => {
    const { service, tx, audit, vuvagent, records } = setup();
    records.findFirst.mockResolvedValue({ id: 'rec-1', status: 'processing' });

    const result = await service.findLeads({ topic: '  โลจิสติกส์ ' }, seller);

    expect(tx.agentRecord.create).toHaveBeenCalledWith({
      data: {
        companyId: 'osd',
        action: 'lead.find',
        input: { topic: 'โลจิสติกส์' },
        createdBy: 'u-1',
      },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'agent.record.started',
        resourceId: 'rec-1',
      }),
      { prisma: tx },
    );
    expect(vuvagent.dispatch).toHaveBeenCalledWith('osd', 'lead.find', {
      agent_record_id: 'rec-1',
      topic: 'โลจิสติกส์',
    });
    expect(result).toEqual({ id: 'rec-1', status: 'processing' });
  });

  it('a refused dispatch marks the record failed with the reason', async () => {
    const { service, vuvagent, records } = setup();
    vuvagent.dispatch.mockRejectedValue(
      new VuvagentDispatchError(401, 'HTTP 401 invalid key'),
    );

    const result = await service.findLeads({ topic: 'x' }, seller);

    expect(records.update).toHaveBeenCalledWith({
      where: { id: 'rec-1' },
      data: {
        status: 'failed',
        error: 'ส่งงานให้ agent ไม่สำเร็จ: HTTP 401 invalid key',
      },
    });
    expect(result).toMatchObject({ status: 'failed' });
  });
});

describe('AgentRecordsService reads', () => {
  it('list pins the company and the readable actions, and pages', async () => {
    const { service, records } = setup();
    records.findMany.mockResolvedValue([{ id: 'rec-1', createdBy: 'u-1' }]);
    records.count.mockResolvedValue(41);

    const page = await service.list(seller, {
      page: 3,
      page_size: 20,
      status: 'done',
    });

    const where = {
      AND: [
        { companyId: 'osd', action: { in: ['lead.find'] } },
        { status: 'done' },
      ],
    };
    expect(records.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where, skip: 40, take: 20 }),
    );
    expect(page).toEqual({
      data: [{ id: 'rec-1', createdBy: 'u-1', createdByName: 'สมชาย' }],
      page: 3,
      page_size: 20,
      total: 41,
    });
  });

  it('list for a caller with no readable action matches nothing', async () => {
    const { service, records } = setup();
    await service.list(outsider, { page: 1, page_size: 20 });
    expect(records.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          AND: [{ companyId: 'osd', action: { in: [] } }, {}],
        },
      }),
    );
  });

  it('a record outside the company or the readable actions answers 404', async () => {
    const { service, records } = setup();
    await expect(service.findOne('rec-9', outsider)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(records.findFirst).toHaveBeenCalledWith({
      where: { id: 'rec-9', companyId: 'osd', action: { in: [] } },
    });
  });

  it('detail of lead.find lists the leads the agent created, within lead scope', async () => {
    const { service, records, leads } = setup();
    records.findFirst.mockResolvedValue({
      id: 'rec-1',
      action: 'lead.find',
      createdBy: 'u-1',
    });
    leads.findMany.mockResolvedValue([{ id: 'lead-1', name: 'บจก. ก' }]);

    const detail = await service.findOne('rec-1', seller);

    const [[args]] = leads.findMany.mock.calls as [
      [{ where: { AND: unknown[] } }],
    ];
    expect(args.where.AND[1]).toEqual({
      intakeData: { path: ['agent_record_id'], equals: 'rec-1' },
    });
    expect(detail).toMatchObject({
      createdByName: 'สมชาย',
      leads: [{ id: 'lead-1', name: 'บจก. ก' }],
    });
  });
});

describe('AgentRecordsService.complete (external callback)', () => {
  const agent = { userId: 'sa-vuvagent', activeCompanyId: 'osd' } as never;
  const OPEN = [
    { status: 'processing' },
    { status: 'failed', timedOutAt: { not: null } },
  ];

  it("finishes only an open row of the key's company, audited in the tx", async () => {
    const { service, tx, audit } = setup();
    tx.agentRecord.findFirst
      .mockResolvedValueOnce({ status: 'processing', timedOutAt: null })
      .mockResolvedValueOnce({ id: 'rec-1', status: 'done' });

    const row = await service.complete(
      'rec-1',
      { status: 'done', result: { leads_created: 3 } },
      agent,
      'osd',
    );

    expect(tx.agentRecord.updateMany).toHaveBeenCalledWith({
      where: { id: 'rec-1', companyId: 'osd', OR: OPEN },
      data: { status: 'done', result: { leads_created: 3 }, error: null },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'agent.record.done',
        resourceId: 'rec-1',
        before: { status: 'processing', timedOutAt: null },
      }),
      { prisma: tx },
    );
    expect(row).toEqual({ id: 'rec-1', status: 'done' });
  });

  it('a late done after the timeout sweep still finishes the job', async () => {
    const { service, tx, audit } = setup();
    tx.agentRecord.findFirst
      .mockResolvedValueOnce({
        status: 'failed',
        timedOutAt: new Date('2026-10-30T03:30:00Z'),
      })
      .mockResolvedValueOnce({ id: 'rec-1', status: 'done' });

    await service.complete('rec-1', { status: 'done' }, agent, 'osd');

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'agent.record.done',
        before: { status: 'failed', timedOutAt: '2026-10-30T03:30:00.000Z' },
      }),
      { prisma: tx },
    );
  });

  it('a second callback answers 409 and changes nothing', async () => {
    const { service, tx, audit } = setup();
    tx.agentRecord.updateMany.mockResolvedValue({ count: 0 });
    tx.agentRecord.findFirst.mockResolvedValue({
      status: 'done',
      timedOutAt: null,
    });

    await expect(
      service.complete('rec-1', { status: 'failed' }, agent, 'osd'),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("another company's record answers 404 before any write", async () => {
    const { service, tx } = setup();
    tx.agentRecord.findFirst.mockResolvedValue(null);

    await expect(
      service.complete('rec-1', { status: 'done' }, agent, 'other-co'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(tx.agentRecord.findFirst).toHaveBeenCalledWith({
      where: { id: 'rec-1', companyId: 'other-co' },
      select: { status: true, timedOutAt: true },
    });
    expect(tx.agentRecord.updateMany).not.toHaveBeenCalled();
  });
});

describe('AgentRecordsService.watch', () => {
  it('pushes each change once and completes when every row is finished', async () => {
    const { service, records } = setup();
    const t0 = new Date('2026-10-27T03:00:00Z');
    const t1 = new Date('2026-10-27T03:00:05Z');
    records.findMany
      .mockResolvedValueOnce([
        { id: 'rec-1', status: 'processing', updatedAt: t0 },
      ])
      .mockResolvedValueOnce([
        { id: 'rec-1', status: 'processing', updatedAt: t0 },
      ])
      .mockResolvedValueOnce([{ id: 'rec-1', status: 'done', updatedAt: t1 }]);

    const events = await lastValueFrom(
      service.watch(['rec-1'], seller).pipe(toArray()),
    );

    expect(events).toEqual([
      {
        type: 'record',
        data: { id: 'rec-1', status: 'processing', updatedAt: t0 },
      },
      { type: 'record', data: { id: 'rec-1', status: 'done', updatedAt: t1 } },
    ]);
    expect(records.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: { in: ['rec-1'] },
          companyId: 'osd',
          action: { in: ['lead.find'] },
        },
      }),
    );
  });
});
