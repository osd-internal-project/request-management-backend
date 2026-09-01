import { BottleneckService } from './bottleneck.service';
import type { Principal } from '@request-management/share';
import type { PrismaService } from '@request-management/share';

const OSD = 'company-osd';
const ME = 'user-me';

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    userId: ME,
    activeCompanyId: OSD,
    companies: [{ id: OSD, name: 'OSD', docPrefix: 'OSD', isPrimary: true }],
    ledUnitIds: [],
    permissions: ['report.request.read'],
    ...overrides,
  } as Principal;
}

/** The half of the query this suite is about. */
interface CapturedWhere {
  case: {
    companyId: string;
    request?: Record<string, unknown>;
  };
}

/** Captures the `where` the service builds without touching a database. */
function serviceWithSpy() {
  const findMany = jest.fn<Promise<unknown[]>, [{ where: CapturedWhere }]>(() =>
    Promise.resolve([]),
  );
  const prisma = { approvalStep: { findMany } } as unknown as PrismaService;

  return {
    service: new BottleneckService(prisma),
    /** The `where` of the single call each test makes. */
    whereOf: () => findMany.mock.calls[0][0].where,
  };
}

describe('REQ-09 bottleneck report — SCOPE-02', () => {
  it('measures only the requests the caller is involved in', async () => {
    const { service, whereOf } = serviceWithSpy();

    await service.report({}, principal());

    const where = whereOf();

    expect(where.case.request).toEqual({
      companyId: OSD,
      OR: [
        { requesterId: ME },
        { receiverUserId: ME },
        { assigneeUserId: ME },
        {
          approvalCases: {
            some: { steps: { some: { candidateUserIds: { has: ME } } } },
          },
        },
      ],
    });
  });

  it('reaches the groups the caller leads, subtree included', async () => {
    const { service, whereOf } = serviceWithSpy();

    await service.report(
      {},
      principal({ ledUnitIds: ['unit-dept', 'unit-position'] }),
    );

    const where = whereOf();
    const units = { in: ['unit-dept', 'unit-position'] };

    expect(where.case.request).toMatchObject({
      companyId: OSD,
      OR: expect.arrayContaining([
        { requesterOrgUnitId: units },
        { receiverOrgUnitId: units },
      ]) as unknown,
    });
  });

  /**
   * The company pin on the case already expresses `request.read.all`, and
   * adding a predicate on the request would drop the cases that have no
   * request at all — APV-07 lets another module open one directly.
   */
  it('adds no request predicate for request.read.all, so case-only rows survive', async () => {
    const { service, whereOf } = serviceWithSpy();

    await service.report(
      {},
      principal({ permissions: ['report.request.read', 'request.read.all'] }),
    );

    const where = whereOf();

    expect(where.case.companyId).toBe(OSD);
    expect(where.case.request).toBeUndefined();
  });

  /**
   * SCOPE-03. The company boundary survived the withdrawal of the scope
   * levels: there is no longer any level that crosses it, not even for a
   * caller who reads the whole company.
   */
  it('pins the active company on every branch', async () => {
    const { service, whereOf } = serviceWithSpy();

    await service.report({}, principal({ ledUnitIds: ['unit-dept'] }));

    expect(whereOf().case.companyId).toBe(OSD);
    expect(whereOf().case.request).toMatchObject({ companyId: OSD });
  });
});
