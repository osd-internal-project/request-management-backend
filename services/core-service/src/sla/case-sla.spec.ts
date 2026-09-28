import {
  DEFAULT_SEVERITY_TARGETS,
  assertSeverityGiven,
  readSeverityTargets,
  severityTargetProblems,
} from './severity';
import { SlaService } from './sla.service';
import { SlaMonitorService } from './sla-monitor.service';

const HOUR = 3_600_000;
// Monday 2026-09-28 10:00 Bangkok
const MONDAY = new Date('2026-09-28T03:00:00Z');

describe('CD-67 severity targets', () => {
  it('the defaults are a valid set', () => {
    expect(severityTargetProblems(DEFAULT_SEVERITY_TARGETS)).toEqual([]);
  });

  it('every level must be present with positive numbers', () => {
    expect(readSeverityTargets({ critical: { responseHours: 1 } })).toBeNull();
    expect(
      readSeverityTargets({
        ...DEFAULT_SEVERITY_TARGETS,
        low: { responseHours: 0, resolutionHours: 10 },
      }),
    ).toBeNull();
    expect(severityTargetProblems(null)).toHaveLength(1);
  });

  it('response may not exceed resolution, and a worse level may not get more time', () => {
    const problems = severityTargetProblems({
      ...DEFAULT_SEVERITY_TARGETS,
      critical: { responseHours: 10, resolutionHours: 8 },
    });
    expect(problems).toEqual(
      expect.arrayContaining([
        'critical: เวลาตอบกลับต้องไม่เกินเวลาแก้ไข',
        'critical: ระดับที่รุนแรงกว่าต้องได้เวลาไม่มากกว่า high',
      ]),
    );
  });

  it('a case type needs a severity to submit; other types do not', () => {
    expect(() => assertSeverityGiven(true, null)).toThrow(
      'ต้องเลือกระดับความรุนแรงก่อนยื่น',
    );
    expect(() => assertSeverityGiven(true, 'high')).not.toThrow();
    expect(() => assertSeverityGiven(false, null)).not.toThrow();
  });
});

/** Just enough of Prisma for the clock: one config row, one clock row. */
function clockHarness(options: {
  config?: Record<string, unknown> | null;
  clock?: Record<string, unknown> | null;
}) {
  const writes: { op: string; args: Record<string, unknown> }[] = [];
  const prisma = {
    slaConfig: {
      findFirst: jest.fn(() => Promise.resolve(options.config ?? null)),
    },
    holidayCalendar: { findUnique: jest.fn(() => Promise.resolve(null)) },
    slaClock: {
      upsert: jest.fn((args: Record<string, unknown>) => {
        writes.push({ op: 'upsert', args });
        return Promise.resolve({});
      }),
      findUnique: jest.fn(() => Promise.resolve(options.clock ?? null)),
      update: jest.fn((args: Record<string, unknown>) => {
        writes.push({ op: 'update', args });
        return Promise.resolve({});
      }),
    },
    request: {
      update: jest.fn((args: Record<string, unknown>) => {
        writes.push({ op: 'request', args });
        return Promise.resolve({});
      }),
    },
  };
  const service = new SlaService(prisma as never);
  return { service, prisma, writes };
}

const request = (severity: string | null) =>
  ({
    id: 'req-1',
    companyId: 'company-osd',
    typeCode: 'CASE',
    severity,
    requestType: { slaHours: 48, slaCoverage: 'H24X7' },
  }) as never;

describe('CD-67 SlaService — two clocks for a case', () => {
  const caseConfig = {
    hours: 48,
    coverage: 'H24X7',
    severityTargets: DEFAULT_SEVERITY_TARGETS,
  };

  it('CD-67: a high case gets 24h to resolve and 4h to respond, from its severity', async () => {
    const { prisma } = clockHarness({ config: caseConfig });
    const service = new SlaService({} as never);

    await service.start(prisma as never, request('high'), MONDAY);

    const created = (
      prisma.slaClock.upsert.mock.calls[0] as unknown as [
        { create: { dueAt: Date; responseDueAt: Date | null } },
      ]
    )[0].create;
    expect(created.dueAt).toEqual(new Date(MONDAY.getTime() + 24 * HOUR));
    expect(created.responseDueAt).toEqual(
      new Date(MONDAY.getTime() + 4 * HOUR),
    );
  });

  it('a type without targets keeps its flat hours and has no response clock', async () => {
    const { prisma } = clockHarness({
      config: { hours: 48, coverage: 'H24X7', severityTargets: null },
    });
    const service = new SlaService({} as never);

    await service.start(prisma as never, request(null), MONDAY);

    const created = (
      prisma.slaClock.upsert.mock.calls[0] as unknown as [
        { create: { dueAt: Date; responseDueAt: Date | null } },
      ]
    )[0].create;
    expect(created.dueAt).toEqual(new Date(MONDAY.getTime() + 48 * HOUR));
    expect(created.responseDueAt).toBeNull();
  });

  it('CD-67: the first response is recorded once; in time is not a breach', async () => {
    const { prisma } = clockHarness({
      clock: {
        responseDueAt: new Date(MONDAY.getTime() + 4 * HOUR),
        respondedAt: null,
        responseBreachedAt: null,
      },
    });
    const service = new SlaService({} as never);

    await service.markResponded(
      'req-1',
      new Date(MONDAY.getTime() + HOUR),
      prisma as never,
    );

    const data = (
      prisma.slaClock.update.mock.calls[0] as unknown as [
        { data: Record<string, unknown> },
      ]
    )[0].data;
    expect(data).toEqual({ respondedAt: new Date(MONDAY.getTime() + HOUR) });
  });

  it('CD-67: a late first response records the breach with it', async () => {
    const { prisma } = clockHarness({
      clock: {
        responseDueAt: new Date(MONDAY.getTime() + 4 * HOUR),
        respondedAt: null,
        responseBreachedAt: null,
      },
    });
    const service = new SlaService({} as never);
    const late = new Date(MONDAY.getTime() + 5 * HOUR);

    await service.markResponded('req-1', late, prisma as never);

    const data = (
      prisma.slaClock.update.mock.calls[0] as unknown as [
        { data: Record<string, unknown> },
      ]
    )[0].data;
    expect(data).toEqual({ respondedAt: late, responseBreachedAt: late });
  });

  it('a second response, or a request with no response clock, changes nothing', async () => {
    for (const clock of [
      { responseDueAt: MONDAY, respondedAt: MONDAY, responseBreachedAt: null },
      { responseDueAt: null, respondedAt: null, responseBreachedAt: null },
      null,
    ]) {
      const { prisma } = clockHarness({ clock });
      const service = new SlaService({} as never);
      await service.markResponded('req-1', MONDAY, prisma as never);
      expect(prisma.slaClock.update).not.toHaveBeenCalled();
    }
  });
});

describe('CD-67 SlaMonitorService — response overdue', () => {
  function monitorHarness(clocks: unknown[], flagged = 1) {
    const notified: unknown[][] = [];
    const prisma = {
      slaClock: {
        findMany: jest.fn((args: { where: Record<string, unknown> }) =>
          Promise.resolve('respondedAt' in args.where ? clocks : []),
        ),
        updateMany: jest.fn(() => Promise.resolve({ count: flagged })),
        update: jest.fn(),
      },
      orgUnit: {
        findMany: jest.fn(() =>
          Promise.resolve([{ id: 'ou-support', managerUserId: 'u-head' }]),
        ),
      },
      requestEvent: {
        findFirst: jest.fn(() => Promise.resolve({ seq: 3 })),
        create: jest.fn(() => Promise.resolve({})),
      },
    };
    const notifications = {
      slaResponseOverdue: jest.fn((...args: unknown[]) => {
        notified.push(args);
        return Promise.resolve();
      }),
    };
    const monitor = new SlaMonitorService(
      prisma as never,
      notifications as never,
      { emit: jest.fn() } as never,
      { get: jest.fn(() => 0) } as never,
    );
    return { monitor, prisma, notified };
  }

  const overdue = {
    requestId: 'req-1',
    request: {
      id: 'req-1',
      companyId: 'company-osd',
      requestNo: 'REQ-1',
      severity: 'critical',
      receiverUserId: 'u-receiver',
      assigneeUserId: 'u-receiver',
      receiverOrgUnitId: 'ou-support',
    },
  };

  it('CD-67: flags a case past its response time once and tells the receiving side', async () => {
    const { monitor, prisma, notified } = monitorHarness([overdue]);

    const result = await monitor.sweep(MONDAY);

    expect(result.responseOverdue).toBe(1);
    expect(prisma.slaClock.updateMany).toHaveBeenCalledWith({
      where: { requestId: 'req-1', responseBreachedAt: null },
      data: { responseBreachedAt: MONDAY },
    });
    // receiver (also the assignee, once) + head of the receiving team
    expect(notified.map((args) => args[0])).toEqual(['u-receiver', 'u-head']);
    expect(prisma.requestEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'sla.response_overdue',
          seq: 4,
        }) as unknown,
      }),
    );
  });

  it('a clock another sweep already flagged is not notified again', async () => {
    const { monitor, notified } = monitorHarness([overdue], 0);
    await monitor.sweep(MONDAY);
    expect(notified).toHaveLength(0);
  });
});

describe('CD-67 SlaService.setSeverityTargets — A2 makes a type a case', () => {
  function configHarness(existing: Record<string, unknown> | null) {
    const prisma = {
      slaConfig: {
        findFirst: jest.fn(() => Promise.resolve(existing)),
        upsert: jest.fn(() => Promise.resolve({})),
        updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
      },
    };
    return { prisma, service: new SlaService({} as never) };
  }
  const type = { code: 'CASE', slaHours: 48, slaCoverage: 'H8X5' as const };

  it("CD-67: a company with no config row gets one carrying the type's own hours and coverage", async () => {
    const { prisma, service } = configHarness(null);

    const previous = await service.setSeverityTargets(
      prisma as never,
      'company-osd',
      type,
      DEFAULT_SEVERITY_TARGETS,
      'u-admin',
    );

    expect(previous).toBeNull();
    expect(prisma.slaConfig.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          hours: 48,
          coverage: 'H8X5',
          severityTargets: DEFAULT_SEVERITY_TARGETS,
        }) as unknown,
      }),
    );
  });

  it('turning it off clears the targets and reports what they were', async () => {
    const { prisma, service } = configHarness({
      severityTargets: DEFAULT_SEVERITY_TARGETS,
    });

    const previous = await service.setSeverityTargets(
      prisma as never,
      'company-osd',
      type,
      null,
      'u-admin',
    );

    expect(previous).toEqual(DEFAULT_SEVERITY_TARGETS);
    expect(prisma.slaConfig.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.slaConfig.upsert).not.toHaveBeenCalled();
  });

  it('turning off a type that was never a case writes nothing', async () => {
    const { prisma, service } = configHarness(null);
    await service.setSeverityTargets(
      prisma as never,
      'company-osd',
      type,
      null,
      'u-admin',
    );
    expect(prisma.slaConfig.updateMany).not.toHaveBeenCalled();
  });
});
