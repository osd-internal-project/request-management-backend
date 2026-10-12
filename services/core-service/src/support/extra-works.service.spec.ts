import type { Principal } from '@request-management/share';
import { ExtraWorksService } from './extra-works.service';

const engineer = {
  userId: 'u-eng',
  activeCompanyId: 'osd',
  permissions: ['notification.read'],
} as unknown as Principal;

function harness(status = 'in_progress', assignee = 'u-eng') {
  const rows: Record<string, unknown>[] = [];
  const extras = {
    findMany: jest.fn((args: { where: { status?: string } }) =>
      Promise.resolve(
        rows.filter(
          (row) => !args.where.status || row.status === args.where.status,
        ),
      ),
    ),
    findFirst: jest.fn((args: { where: { id?: string } }) =>
      Promise.resolve(
        args.where.id
          ? (rows.find((row) => row.id === args.where.id) ?? null)
          : (rows[rows.length - 1] ?? null),
      ),
    ),
    count: jest.fn(() => Promise.resolve(rows.length)),
    create: jest.fn((args: { data: Record<string, unknown> }) => {
      const row = {
        id: `x-${rows.length + 1}`,
        status: 'proposed',
        createdAt: new Date(),
        ackName: null,
        ackOn: null,
        decidedBy: null,
        decidedAt: null,
        declineNote: null,
        ...args.data,
      };
      rows.push(row);
      return Promise.resolve(row);
    }),
    updateMany: jest.fn(
      (args: {
        where: { id: string; status: string };
        data: Record<string, unknown>;
      }) => {
        const row = rows.find(
          (item) =>
            item.id === args.where.id && item.status === args.where.status,
        );
        if (!row) return Promise.resolve({ count: 0 });
        Object.assign(row, args.data);
        return Promise.resolve({ count: 1 });
      },
    ),
  };
  const orders = {
    findFirst: jest.fn(() =>
      Promise.resolve({
        id: 'wo-1',
        companyId: 'osd',
        requestId: 'r-1',
        billing: 'in_contract',
      }),
    ),
  };
  const requestRows = {
    findFirst: jest.fn(() =>
      Promise.resolve({ status, assigneeUserId: assignee }),
    ),
  };
  const guards: ((request: { id: string }) => Promise<void>)[] = [];
  const requests = {
    addGuard: jest.fn(
      (_action: string, guard: (request: { id: string }) => Promise<void>) =>
        guards.push(guard),
    ),
  };
  const service = new ExtraWorksService(
    extras as never,
    orders as never,
    requestRows as never,
    requests as never,
    { findMany: () => Promise.resolve([]) } as never,
    { record: () => Promise.resolve() } as never,
    { execute: (work: (tx: unknown) => Promise<unknown>) => work({}) } as never,
  );
  service.onModuleInit();
  return { service, guards, rows };
}

describe('CD-228 out-of-contract work — service', () => {
  it('proposed while working, holds the job open until the customer answers, then charged when agreed', async () => {
    const h = harness();
    const listed = await h.service.propose(engineer, 'wo-1', {
      description: 'เปลี่ยนสาย',
      reason: 'หนูกัด',
      estimate: 1500,
    });
    expect(listed.items[0]).toMatchObject({ label: 'X-1', status: 'proposed' });
    await expect(h.guards[0]({ id: 'r-1' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    // agreeing needs who and when
    await expect(
      h.service.decide(engineer, 'x-1', { decision: 'agreed' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const agreed = await h.service.decide(engineer, 'x-1', {
      decision: 'agreed',
      name: 'คุณบี',
      on: '2026-10-01',
    });
    expect(agreed).toMatchObject({ agreedTotal: 1500 });
    await expect(h.guards[0]({ id: 'r-1' })).resolves.toBeUndefined();
    await expect(h.service.agreedOf('wo-1')).resolves.toEqual([
      expect.objectContaining({ seq: 1, estimate: 1500 }),
    ]);
    await expect(
      h.service.decide(engineer, 'x-1', { decision: 'declined' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('declined is kept on record and not charged', async () => {
    const h = harness();
    await h.service.propose(engineer, 'wo-1', {
      description: 'ย้ายกล้อง',
      reason: 'ลูกค้าขอเพิ่ม',
      estimate: 900,
    });
    const view = await h.service.decide(engineer, 'x-1', {
      decision: 'declined',
      note: 'ยังไม่มีงบ',
    });
    expect(view.items[0]).toMatchObject({
      status: 'declined',
      declineNote: 'ยังไม่มีงบ',
    });
    await expect(h.service.agreedOf('wo-1')).resolves.toEqual([]);
  });

  it('only while the job is under way, and only by whoever works it', async () => {
    await expect(
      harness('submitted').service.propose(engineer, 'wo-1', {
        description: 'a',
        reason: 'b',
        estimate: 1,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      harness('in_progress', 'u-other').service.propose(engineer, 'wo-1', {
        description: 'a',
        reason: 'b',
        estimate: 1,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
