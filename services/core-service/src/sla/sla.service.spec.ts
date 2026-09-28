import { SlaService } from './sla.service';

const HOUR_MS = 60 * 60 * 1000;

/** A clock row as `resume` loads it, with the request and type it reads. */
function storedClock(overrides: Record<string, unknown> = {}) {
  return {
    requestId: 'req-1',
    state: 'paused',
    startedAt: new Date('2026-09-25T01:00:00Z'),
    pausedAt: new Date('2026-09-25T01:00:00Z'),
    accumulatedMs: 0,
    dueAt: new Date('2026-09-25T01:00:00Z'),
    request: {
      companyId: 'company-osd',
      typeCode: 'DSC',
      requestType: { slaHours: 8, slaCoverage: 'H24X7' },
    },
    ...overrides,
  };
}

function prismaWith(clock: Record<string, unknown> | null = storedClock()) {
  const clockWrites: Record<string, unknown>[] = [];
  const requestWrites: Record<string, unknown>[] = [];

  const prisma = {
    slaConfig: { findFirst: jest.fn(() => Promise.resolve(null)) },
    holidayCalendar: { findUnique: jest.fn(() => Promise.resolve(null)) },
    slaClock: {
      findUnique: jest.fn(() => Promise.resolve(clock)),
      upsert: jest.fn((args: Record<string, unknown>) => {
        clockWrites.push(args);
        return Promise.resolve({});
      }),
      update: jest.fn((args: Record<string, unknown>) => {
        clockWrites.push(args);
        return Promise.resolve({});
      }),
    },
    request: {
      update: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        requestWrites.push(data);
        return Promise.resolve({});
      }),
    },
  };

  return { prisma, clockWrites, requestWrites };
}

const service = new SlaService({} as never);

const submitted = {
  id: 'req-1',
  companyId: 'company-osd',
  typeCode: 'DSC',
  requestType: { slaHours: 8, slaCoverage: 'H24X7' },
} as never;

describe('SUP-01: the SLA counts from the first assignment (PO, 25 Sep 2026)', () => {
  it('creates the clock paused at submit and shows no deadline yet', async () => {
    const at = new Date('2026-09-25T01:00:00Z');
    const { prisma, clockWrites, requestWrites } = prismaWith();

    await service.start(prisma as never, submitted, at);

    expect(clockWrites[0]).toMatchObject({
      create: { state: 'paused', pausedAt: at, startedAt: at },
    });
    expect(requestWrites).toEqual([{ dueAt: null }]);
  });

  it('starts counting the full budget when the work is assigned', async () => {
    const assignedAt = new Date('2026-09-25T05:00:00Z');
    const { prisma, clockWrites, requestWrites } = prismaWith();

    await service.resume(prisma as never, 'req-1', assignedAt);

    const dueAt = new Date(assignedAt.getTime() + 8 * HOUR_MS);
    expect(clockWrites[0]).toMatchObject({
      data: { state: 'running', startedAt: assignedAt, dueAt },
    });
    expect(requestWrites).toEqual([{ dueAt }]);
  });

  it('does nothing when a later assignment finds the clock already running', async () => {
    const { prisma, clockWrites } = prismaWith(
      storedClock({ state: 'running', pausedAt: null }),
    );

    await service.resume(prisma as never, 'req-1');

    expect(clockWrites).toHaveLength(0);
  });

  it('creates no clock for a type without an SLA', async () => {
    const { prisma, clockWrites } = prismaWith();

    await service.start(
      prisma as never,
      { ...(submitted as object), requestType: { slaHours: null } } as never,
      new Date(),
    );

    expect(clockWrites).toHaveLength(0);
  });
});

describe('SUP-01: met or breached is judged from the time actually used', () => {
  function clockUsing(accumulatedMs: number, state: 'running' | 'paused') {
    return storedClock({
      state,
      accumulatedMs,
      startedAt: new Date('2026-09-28T01:00:00Z'),
      // A deadline long past: judging by wall clock would call this breached.
      dueAt: new Date('2026-09-20T00:00:00Z'),
    });
  }

  it('is met when the paused clock used less than the budget, however late it is now', async () => {
    const { prisma, clockWrites } = prismaWith(
      clockUsing(7 * HOUR_MS, 'paused'),
    );

    await service.stop(
      prisma as never,
      'req-1',
      'met',
      new Date('2026-09-28T05:00:00Z'),
    );

    expect(clockWrites[0]).toMatchObject({
      data: { state: 'met', accumulatedMs: 7 * HOUR_MS },
    });
  });

  it('adds the running stretch before judging', async () => {
    const { prisma, clockWrites } = prismaWith(
      clockUsing(6 * HOUR_MS, 'running'),
    );

    // 6h used + 3h running = 9h against an 8h budget.
    await service.stop(
      prisma as never,
      'req-1',
      'met',
      new Date('2026-09-28T04:00:00Z'),
    );

    expect(clockWrites[0]).toMatchObject({ data: { state: 'breached' } });
  });

  it('marks a cancelled clock without judging it', async () => {
    const { prisma, clockWrites } = prismaWith(
      clockUsing(99 * HOUR_MS, 'paused'),
    );

    await service.stop(prisma as never, 'req-1', 'cancelled');

    expect(clockWrites[0]).toMatchObject({ data: { state: 'cancelled' } });
  });
});
