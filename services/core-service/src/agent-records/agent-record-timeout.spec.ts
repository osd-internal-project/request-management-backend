import { AgentRecordTimeoutService } from './agent-record-timeout.service';

const NOW = new Date('2026-10-30T10:00:00Z');
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000);

/** An in-memory agent_records table the sweep reads and writes through its mocks. */
function setup(
  rows: {
    id: string;
    companyId: string;
    action: string;
    status: string;
    createdAt: Date;
  }[],
  connections: { companyId: string; vendor: string; endpoints: unknown }[],
) {
  const table = rows.map((row) => ({
    ...row,
    timedOutAt: null as Date | null,
  }));
  const matches = (
    row: (typeof table)[number],
    where: Record<string, unknown>,
  ) => {
    const company = where.companyId as string | { notIn: string[] };
    const createdAt = where.createdAt as { lt: Date } | undefined;
    return (
      (typeof company === 'string'
        ? row.companyId === company
        : !company.notIn.includes(row.companyId)) &&
      row.action === where.action &&
      row.status === where.status &&
      (!createdAt || row.createdAt < createdAt.lt)
    );
  };
  const records = {
    findMany: jest.fn(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve(table.filter((row) => matches(row, where))),
    ),
  };
  const tx = {
    agentRecord: {
      updateMany: jest.fn(
        ({
          where,
          data,
        }: {
          where: { id: string; status: string };
          data: { status: string; timedOutAt: Date; error: string };
        }) => {
          const row = table.find(
            (r) => r.id === where.id && r.status === where.status,
          );
          if (!row) return Promise.resolve({ count: 0 });
          Object.assign(row, data);
          return Promise.resolve({ count: 1 });
        },
      ),
    },
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new AgentRecordTimeoutService(
    records as never,
    { findMany: jest.fn().mockResolvedValue(connections) } as never,
    audit as never,
    {
      execute: jest.fn((work: (client: typeof tx) => unknown) => work(tx)),
    } as never,
    { get: jest.fn() } as never,
  );
  return { service, table, audit };
}

describe('AgentRecordTimeoutService.sweep', () => {
  it("uses the company's timeout, else the action default, and touches only processing rows", async () => {
    const { service, table, audit } = setup(
      [
        // company A set 60 minutes: 45 is still running, 70 is overdue
        {
          id: 'a-45',
          companyId: 'A',
          action: 'lead.find',
          status: 'processing',
          createdAt: minutesAgo(45),
        },
        {
          id: 'a-70',
          companyId: 'A',
          action: 'lead.find',
          status: 'processing',
          createdAt: minutesAgo(70),
        },
        // company B has no connection row: the 30-minute default applies
        {
          id: 'b-45',
          companyId: 'B',
          action: 'lead.find',
          status: 'processing',
          createdAt: minutesAgo(45),
        },
        {
          id: 'b-done',
          companyId: 'B',
          action: 'lead.find',
          status: 'done',
          createdAt: minutesAgo(90),
        },
      ],
      [
        {
          companyId: 'A',
          vendor: 'vuvagent',
          endpoints: {
            'lead.find': { endpointId: 'ep_1', timeoutMinutes: 60 },
          },
        },
      ],
    );

    await expect(service.sweep(NOW)).resolves.toBe(2);

    expect(
      table.map((row) => [
        row.id,
        row.status,
        row.timedOutAt?.toISOString() ?? null,
      ]),
    ).toEqual([
      ['a-45', 'processing', null],
      ['a-70', 'failed', NOW.toISOString()],
      ['b-45', 'failed', NOW.toISOString()],
      ['b-done', 'done', null],
    ]);
    expect(table.find((row) => row.id === 'a-70')).toMatchObject({
      error: 'agent ไม่ตอบกลับภายใน 60 นาที',
    });
    expect(audit.record).toHaveBeenCalledTimes(2);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'agent.record.timed_out',
        resourceId: 'b-45',
        actorUsername: 'system',
      }),
      expect.anything(),
    );
  });

  it('running it again closes nothing new', async () => {
    const { service, audit } = setup(
      [
        {
          id: 'b-45',
          companyId: 'B',
          action: 'lead.find',
          status: 'processing',
          createdAt: minutesAgo(45),
        },
      ],
      [],
    );

    await expect(service.sweep(NOW)).resolves.toBe(1);
    await expect(service.sweep(NOW)).resolves.toBe(0);
    expect(audit.record).toHaveBeenCalledTimes(1);
  });
});
