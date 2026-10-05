import { DEFAULT_SEVERITY_TARGETS } from './severity';
import { SlaService } from './sla.service';

const HOUR = 3_600_000;
// Monday 2026-09-28 10:00 Bangkok
const MONDAY = new Date('2026-09-28T03:00:00Z');

const MA = {
  critical: { responseHours: 0.5, resolutionHours: 2 },
  high: { responseHours: 1, resolutionHours: 6 },
  medium: { responseHours: 4, resolutionHours: 24 },
  low: { responseHours: 8, resolutionHours: 48 },
};

/** A case type with the standard targets; a work order on an entitlement. */
function harness(input: {
  order: {
    billing?: string | null;
    entitlementId: string | null;
    suggestedEntitlementId: string | null;
  } | null;
  entitlement: { severityTargets: unknown; coverage: string | null } | null;
  clock?: Record<string, unknown> | null;
}) {
  return {
    slaConfig: {
      findFirst: jest.fn(() =>
        Promise.resolve({
          hours: 48,
          coverage: 'H24X7',
          severityTargets: DEFAULT_SEVERITY_TARGETS,
        }),
      ),
    },
    holidayCalendar: { findUnique: jest.fn(() => Promise.resolve(null)) },
    customerContract: { findFirst: jest.fn(() => Promise.resolve(null)) },
    serviceWorkOrder: {
      findUnique: jest.fn(() => Promise.resolve(input.order)),
    },
    serviceEntitlement: {
      findUnique: jest.fn(() => Promise.resolve(input.entitlement)),
    },
    slaClock: {
      upsert: jest.fn(() => Promise.resolve({})),
      findUnique: jest.fn(() => Promise.resolve(input.clock ?? null)),
      update: jest.fn(() => Promise.resolve({})),
    },
    request: { update: jest.fn(() => Promise.resolve({})) },
  };
}

const workOrderCase = (severity = 'high') =>
  ({
    id: 'req-1',
    companyId: 'osd',
    typeCode: 'SVC',
    severity,
    refType: 'customer',
    refId: 'CUS-1',
    submittedAt: MONDAY,
    requestType: { slaHours: 48, slaCoverage: 'H24X7' },
  }) as never;

describe('CD-240 a service work order is clocked on its entitlement', () => {
  it('the entitlement’s levels, before the type’s', async () => {
    const prisma = harness({
      order: { entitlementId: 'ma', suggestedEntitlementId: null },
      entitlement: { severityTargets: MA, coverage: 'H24X7' },
    });
    await new SlaService({} as never).start(
      prisma as never,
      workOrderCase(),
      MONDAY,
    );
    const created = (
      prisma.slaClock.upsert.mock.calls[0] as unknown as [
        { create: { dueAt: Date; responseDueAt: Date } },
      ]
    )[0].create;
    // high: 6h to resolve, 1h to respond (the type would give 24h / 4h)
    expect(created.dueAt).toEqual(new Date(MONDAY.getTime() + 6 * HOUR));
    expect(created.responseDueAt).toEqual(
      new Date(MONDAY.getTime() + 1 * HOUR),
    );
  });

  it('the suggested entitlement until one is confirmed; none — the type’s', async () => {
    const suggested = harness({
      order: { entitlementId: null, suggestedEntitlementId: 'w' },
      entitlement: { severityTargets: MA, coverage: null },
    });
    await new SlaService({} as never).start(
      suggested as never,
      workOrderCase(),
      MONDAY,
    );
    expect(suggested.serviceEntitlement.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'w' } }),
    );
    const none = harness({ order: null, entitlement: null });
    await new SlaService({} as never).start(
      none as never,
      workOrderCase(),
      MONDAY,
    );
    const created = (
      none.slaClock.upsert.mock.calls[0] as unknown as [
        { create: { dueAt: Date } },
      ]
    )[0].create;
    expect(created.dueAt).toEqual(new Date(MONDAY.getTime() + 24 * HOUR));
  });

  it('a job confirmed as billed is not under the cover: the type’s levels', async () => {
    const billed = harness({
      order: {
        billing: 'billable',
        entitlementId: null,
        suggestedEntitlementId: 'w',
      },
      entitlement: { severityTargets: MA, coverage: null },
    });
    await new SlaService({} as never).start(
      billed as never,
      workOrderCase(),
      MONDAY,
    );
    expect(billed.serviceEntitlement.findUnique).not.toHaveBeenCalled();
  });

  it('retarget: the time used stays used, the rest runs on the new levels', async () => {
    // started on the type's 24h at 10:00; at 12:00 the 6h entitlement applies
    const prisma = harness({
      order: { entitlementId: 'ma', suggestedEntitlementId: null },
      entitlement: { severityTargets: MA, coverage: 'H24X7' },
      clock: {
        requestId: 'req-1',
        state: 'running',
        startedAt: MONDAY,
        accumulatedMs: 0,
        respondedAt: null,
        request: workOrderCase(),
      },
    });
    const noon = new Date(MONDAY.getTime() + 2 * HOUR);
    await new SlaService({} as never).retarget(prisma as never, 'req-1', noon);
    const update = (
      prisma.slaClock.update.mock.calls[0] as unknown as [
        { data: { dueAt: Date; responseDueAt: Date; accumulatedMs: number } },
      ]
    )[0].data;
    expect(update.accumulatedMs).toBe(2 * HOUR);
    expect(update.dueAt).toEqual(new Date(noon.getTime() + 4 * HOUR));
    expect(update.responseDueAt).toEqual(new Date(MONDAY.getTime() + 1 * HOUR));
  });

  it('retarget leaves a response already given, and a stopped clock, alone', async () => {
    const responded = harness({
      order: { entitlementId: 'ma', suggestedEntitlementId: null },
      entitlement: { severityTargets: MA, coverage: 'H24X7' },
      clock: {
        requestId: 'req-1',
        state: 'paused',
        startedAt: MONDAY,
        accumulatedMs: HOUR,
        respondedAt: MONDAY,
        request: workOrderCase(),
      },
    });
    await new SlaService({} as never).retarget(
      responded as never,
      'req-1',
      MONDAY,
    );
    expect(responded.slaClock.update).not.toHaveBeenCalled();
    const met = harness({
      order: null,
      entitlement: null,
      clock: { requestId: 'req-1', state: 'met', request: workOrderCase() },
    });
    await new SlaService({} as never).retarget(met as never, 'req-1', MONDAY);
    expect(met.slaClock.update).not.toHaveBeenCalled();
  });
});
