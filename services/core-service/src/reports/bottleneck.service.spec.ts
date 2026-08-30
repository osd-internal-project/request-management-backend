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
    teamOrgUnitIds: ['unit-team'],
    departmentOrgUnitIds: ['unit-team', 'unit-dept'],
    scopes: { request: 'own' },
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
  it('narrows to the requests the caller can see at scope own', async () => {
    const { service, whereOf } = serviceWithSpy();

    await service.report({}, principal({ scopes: { request: 'own' } }));

    const where = whereOf();

    expect(where.case.request).toEqual({
      companyId: OSD,
      requesterId: ME,
    });
  });

  it('narrows to the org subtree at scope team', async () => {
    const { service, whereOf } = serviceWithSpy();

    await service.report({}, principal({ scopes: { request: 'team' } }));

    const where = whereOf();

    expect(where.case.request).toEqual({
      companyId: OSD,
      requesterOrgUnitId: { in: ['unit-team'] },
    });
  });

  /**
   * The company pin on the case already expresses `company`, and adding a
   * predicate on the request would drop the cases that have no request at all —
   * APV-07 lets another module open one directly.
   */
  it('adds no request predicate at scope company, so case-only rows survive', async () => {
    const { service, whereOf } = serviceWithSpy();

    await service.report({}, principal({ scopes: { request: 'company' } }));

    const where = whereOf();

    expect(where.case.companyId).toBe(OSD);
    expect(where.case.request).toBeUndefined();
  });

  it('adds no request predicate at scope all either', async () => {
    const { service, whereOf } = serviceWithSpy();

    await service.report({}, principal({ scopes: { request: 'all' } }));

    const where = whereOf();

    expect(where.case.request).toBeUndefined();
  });

  it('defaults to own when the role declares no request scope', async () => {
    const { service, whereOf } = serviceWithSpy();

    await service.report({}, principal({ scopes: {} }));

    const where = whereOf();

    expect(where.case.request).toEqual({ companyId: OSD, requesterId: ME });
  });
});
