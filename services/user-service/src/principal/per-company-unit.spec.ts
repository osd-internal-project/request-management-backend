import { PrincipalService } from './principal.service';

/**
 * One person, one Keycloak account, a unit in each company's chart (17 Nov 2026):
 * chareefm sits in OSD's RND and in D CALL's RND at once, and the principal
 * carries the unit of the company being acted in — never the other company's.
 */
describe('a person placed in several companies', () => {
  const USER = {
    id: 'u-1',
    keycloakId: 'kc-1',
    username: 'chareefm',
    displayName: 'Chareef',
    email: 'chareefm@osd.co.th',
    orgUnitId: 'rnd-osd', // legacy column: must not leak into D CALL
    supervisorUserId: null,
    lastCompanyId: null,
    primaryCompanyId: 'osd',
    status: 'ACTIVE',
  };

  function serviceWith(memberships: { companyId: string; orgUnitId: string | null }[]) {
    const org = {
      companiesForUser: jest.fn().mockResolvedValue(
        memberships.map((m, i) => ({
          ...m,
          isPrimary: i === 0,
          company: { id: m.companyId, name: m.companyId, docPrefix: m.companyId },
        })),
      ),
      ledUnitIdsOf: jest.fn().mockResolvedValue([]),
      levelUnitIdsOf: jest.fn().mockResolvedValue([]),
      scopedAccessOf: jest.fn().mockResolvedValue({
        readUnits: [], actUnits: [], readUsers: [], actUsers: [], byPermission: {},
      }),
    };
    const service = new PrincipalService(
      { findActiveByEmail: jest.fn().mockResolvedValue(USER) } as never,
      org as never,
      {
        rolesForUser: jest.fn().mockResolvedValue([]),
        effectivePermissions: jest.fn().mockResolvedValue([]),
        systemPermissionsOf: jest.fn().mockResolvedValue([]),
      } as never,
      {
        resolveVisibleSensitiveFields: jest.fn().mockResolvedValue([]),
        listAllSensitiveFieldKeys: jest.fn().mockResolvedValue([]),
      } as never,
      { get: () => 'request-form' } as never,
      { record: jest.fn() } as never,
    );
    return { service, org };
  }

  const both = [
    { companyId: 'osd', orgUnitId: 'rnd-osd' },
    { companyId: 'dcall', orgUnitId: 'rnd-dcall' },
  ];

  it('carries the unit of the company being acted in', async () => {
    const { service, org } = serviceWith(both);

    const inOsd = await service.resolveByEmail(USER.email, 'osd');
    const inDcall = await service.resolveByEmail(USER.email, 'dcall');

    expect(inOsd.orgUnitId).toBe('rnd-osd');
    expect(inDcall.orgUnitId).toBe('rnd-dcall');
    // the level visibility climbs D CALL's chart, not OSD's
    expect(org.levelUnitIdsOf).toHaveBeenLastCalledWith('rnd-dcall', 'dcall', []);
  });

  it('has no unit in a company that has not placed them, yet is not locked out', async () => {
    const { service } = serviceWith([
      { companyId: 'osd', orgUnitId: 'rnd-osd' },
      { companyId: 'dcall', orgUnitId: null },
    ]);

    const inDcall = await service.resolveByEmail(USER.email, 'dcall');

    expect(inDcall.orgUnitId).toBeNull();
    expect(inDcall.pendingOrgAssignment).toBe(false);
  });

  it('is pending only when no company has placed them', async () => {
    const { service } = serviceWith([{ companyId: 'osd', orgUnitId: null }]);

    const principal = await service.resolveByEmail(USER.email, 'osd');

    expect(principal.pendingOrgAssignment).toBe(true);
  });
});
