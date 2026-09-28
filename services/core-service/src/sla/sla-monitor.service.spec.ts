import { SlaMonitorService } from './sla-monitor.service';

const AT = new Date('2026-09-28T10:00:00Z');

function overdueClock(
  overrides: Record<string, unknown> = {},
  level = 0,
  id = 'clock-1',
) {
  return {
    id,
    requestId: 'req-1',
    state: 'running',
    escalationLevel: level,
    dueAt: new Date('2026-09-28T09:00:00Z'),
    breachedAt: null,
    request: {
      id: 'req-1',
      companyId: 'company-osd',
      typeCode: 'IT',
      requestNo: 'OSD-IT-0012',
      requesterId: 'user-requester',
      receiverUserId: 'user-receiver',
      assigneeUserId: 'user-worker',
      requestType: { slaHours: 8 },
      approvalCases: [],
      ...overrides,
    },
  };
}

function monitorWith(options: {
  clocks?: unknown[][];
  near?: unknown[][];
  steps?: unknown[][];
  percent?: number | null;
}) {
  const clocks = options.clocks ?? [[]];
  const near = options.near ?? [[]];
  const steps = options.steps ?? [[]];
  const notified: string[] = [];
  const warned: string[] = [];
  const overdue: [string, boolean][] = [];
  const clockWrites: Record<string, unknown>[] = [];
  const findMany = jest.fn((args: { where: { dueAt?: { gte?: Date } } }) =>
    Promise.resolve(
      // CD-67's response pass filters on `responseDueAt`, not `dueAt`: none here.
      !args.where.dueAt
        ? []
        : (('gte' in args.where.dueAt ? near.shift() : clocks.shift()) ?? []),
    ),
  );

  const monitor = new SlaMonitorService(
    {
      slaClock: {
        findMany,
        update: jest.fn(({ data }: { data: Record<string, unknown> }) => {
          clockWrites.push(data);
          return Promise.resolve({});
        }),
      },
      slaConfig: { findFirst: jest.fn(() => Promise.resolve(null)) },
      approvalStep: {
        findMany: jest.fn(() => Promise.resolve(steps.shift() ?? [])),
        update: jest.fn(() => Promise.resolve({})),
      },
      user: {
        findUnique: jest.fn(() => Promise.resolve({ orgUnitId: 'ou-1' })),
      },
      $transaction: jest.fn(() => Promise.resolve()),
    } as never,
    {
      slaBreached: jest.fn((userId: string) => {
        notified.push(userId);
        return Promise.resolve();
      }),
      slaWarning: jest.fn((userId: string) => {
        warned.push(userId);
        return Promise.resolve();
      }),
      approvalOverdue: jest.fn(
        (userId: string, _c: string, _l: unknown, escalated: boolean) => {
          overdue.push([userId, escalated]);
          return Promise.resolve();
        },
      ),
    } as never,
    { emit: jest.fn(() => Promise.resolve()) } as never,
    { get: jest.fn(() => 0) } as never,
    {
      percentUsed: jest.fn(() => Promise.resolve(options.percent ?? 110)),
      dueAfter: jest.fn(
        (_p: unknown, _c: string, _t: unknown, hours: number, from: Date) =>
          Promise.resolve(new Date(from.getTime() + hours * 3_600_000)),
      ),
    } as never,
    {
      approverCandidatesOf: jest.fn((level: { up: number }) =>
        Promise.resolve([`user-head-${level.up}`]),
      ),
    } as never,
  );

  return { monitor, notified, warned, overdue, clockWrites, findMany };
}

describe('SUP-02: escalation reaches whoever is holding the work up', () => {
  it('tells the holder, the requester and the team head at the first tier', async () => {
    const { monitor, notified } = monitorWith({ clocks: [[overdueClock()]] });

    await monitor.sweep(AT);

    expect(notified).toEqual(['user-worker', 'user-requester', 'user-head-1']);
  });

  it('includes the candidates of the approval step it is waiting on, not the next one', async () => {
    const { monitor, notified } = monitorWith({
      clocks: [
        [
          overdueClock({
            approvalCases: [
              {
                currentStep: 1,
                steps: [
                  {
                    stepNo: 1,
                    candidateUserIds: ['user-a', 'user-b'],
                    approverUserId: 'user-a',
                  },
                  {
                    stepNo: 2,
                    candidateUserIds: ['user-next'],
                    approverUserId: 'user-next',
                  },
                ],
              },
            ],
          }),
        ],
      ],
    });

    await monitor.sweep(AT);

    expect(notified).toContain('user-a');
    expect(notified).toContain('user-b');
    expect(notified).not.toContain('user-next');
  });

  it('climbs one more head at 150% and records the tier, keeping the clock running', async () => {
    const { monitor, notified, clockWrites } = monitorWith({
      clocks: [[overdueClock({}, 1)]],
      percent: 160,
    });

    await monitor.sweep(AT);

    expect(notified).toContain('user-head-2');
    expect(notified).not.toContain('user-head-1');
    expect(clockWrites[0]).toMatchObject({ escalationLevel: 2 });
    expect(clockWrites[0]).not.toHaveProperty('state');
  });

  it('does not repeat a tier already fired', async () => {
    const { monitor, notified } = monitorWith({
      clocks: [[overdueClock({}, 1)]],
      percent: 120,
    });

    await monitor.sweep(AT);

    expect(notified).toEqual([]);
  });

  it('keeps paging past a full batch instead of stopping at 200', async () => {
    const full = Array.from({ length: 200 }, (_, index) =>
      overdueClock({}, 0, `clock-${index}`),
    );
    const { monitor, findMany } = monitorWith({
      clocks: [full, [overdueClock()]],
    });

    const result = await monitor.sweep(AT);

    expect(result.breached).toBe(201);
    expect(findMany.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('warns whoever holds the work before the deadline', async () => {
    const { monitor, warned } = monitorWith({ near: [[overdueClock()]] });

    await monitor.sweep(AT);

    expect(warned).toEqual(['user-worker']);
  });
});

describe('SUP-02: an approval step past its own deadline', () => {
  function overdueStep(level: number, dueAt: Date) {
    return {
      id: 'step-1',
      escalationLevel: level,
      dueAt,
      slaHours: 8,
      candidateUserIds: ['user-a'],
      approverUserId: 'user-a',
      case: {
        id: 'case-1',
        companyId: 'company-osd',
        subjectType: 'request:IT',
        requestId: 'req-1',
        request: { requestNo: 'OSD-IT-0012' },
      },
    };
  }

  it('reminds the candidates once it is past due', async () => {
    const { monitor, overdue } = monitorWith({
      steps: [[overdueStep(0, new Date('2026-09-28T09:00:00Z'))]],
    });

    await monitor.sweep(AT);

    expect(overdue).toEqual([['user-a', false]]);
  });

  it("tells the candidate's head once half the budget again has passed", async () => {
    const { monitor, overdue } = monitorWith({
      steps: [[overdueStep(1, new Date('2026-09-28T01:00:00Z'))]],
    });

    await monitor.sweep(AT);

    expect(overdue).toEqual([
      ['user-a', false],
      ['user-head-1', true],
    ]);
  });
});
