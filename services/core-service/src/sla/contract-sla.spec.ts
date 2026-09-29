import { DEFAULT_SEVERITY_TARGETS } from './severity';
import { SlaService } from './sla.service';

const HOUR = 3_600_000;
// Monday 2026-09-28 10:00 Bangkok
const MONDAY = new Date('2026-09-28T03:00:00Z');

/** A case type with the standard targets, and one contract that promises better. */
function harness(contractTerms: Record<string, unknown> | null) {
  const prisma = {
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
    customerContract: {
      findFirst: jest.fn(() =>
        Promise.resolve(contractTerms ? { terms: contractTerms } : null),
      ),
    },
    slaClock: { upsert: jest.fn(() => Promise.resolve({})) },
    request: { update: jest.fn(() => Promise.resolve({})) },
  };
  return prisma;
}

const created = (prisma: ReturnType<typeof harness>) =>
  (
    prisma.slaClock.upsert.mock.calls[0] as unknown as [
      { create: { dueAt: Date; responseDueAt: Date | null } },
    ]
  )[0].create;

const caseAgainst = (refId: string | null, severity = 'high') =>
  ({
    id: 'req-1',
    companyId: 'osd',
    typeCode: 'CASE',
    severity,
    refType: refId ? 'contract' : null,
    refId,
    requestType: { slaHours: 48, slaCoverage: 'H24X7' },
  }) as never;

const PREMIUM = {
  critical: { responseHours: 0.5, resolutionHours: 2 },
  high: { responseHours: 1, resolutionHours: 8 },
  medium: { responseHours: 4, resolutionHours: 24 },
  low: { responseHours: 8, resolutionHours: 48 },
};

describe('CD-151 a case is clocked on its contract’s service levels', () => {
  it('a case against a contract with levels gets the contract’s targets, not the type’s', async () => {
    const prisma = harness({ serviceLevels: PREMIUM, serviceCoverage: null });
    await new SlaService({} as never).start(
      prisma as never,
      caseAgainst('CTR-001'),
      MONDAY,
    );
    // high: 8h to resolve, 1h to respond (type would give 24h / 4h)
    expect(created(prisma).dueAt).toEqual(
      new Date(MONDAY.getTime() + 8 * HOUR),
    );
    expect(created(prisma).responseDueAt).toEqual(
      new Date(MONDAY.getTime() + 1 * HOUR),
    );
    expect(prisma.customerContract.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          companyId: 'osd',
          OR: [{ contractNo: 'CTR-001' }, { id: 'CTR-001' }],
        },
      }),
    );
  });

  it('office-hours cover in the contract counts only office hours', async () => {
    const prisma = harness({ serviceLevels: PREMIUM, serviceCoverage: 'H8X5' });
    // Friday 16:00 Bangkok, 8 working hours → Monday 15:00 (default 09–17 day)
    const friday = new Date('2026-10-02T09:00:00Z');
    await new SlaService({} as never).start(
      prisma as never,
      caseAgainst('CTR-001'),
      friday,
    );
    expect(created(prisma).dueAt.getTime()).toBeGreaterThan(
      friday.getTime() + 48 * HOUR,
    );
  });

  it('no levels on the contract, or no contract: the type’s targets as before', async () => {
    for (const prisma of [harness({ serviceLevels: null }), harness(null)]) {
      await new SlaService({} as never).start(
        prisma as never,
        caseAgainst('CTR-001'),
        MONDAY,
      );
      expect(created(prisma).dueAt).toEqual(
        new Date(MONDAY.getTime() + 24 * HOUR),
      );
    }
    // not raised against a contract: the contract is not even looked up
    const plain = harness({ serviceLevels: PREMIUM });
    await new SlaService({} as never).start(
      plain as never,
      caseAgainst(null),
      MONDAY,
    );
    expect(plain.customerContract.findFirst).not.toHaveBeenCalled();
  });
});
