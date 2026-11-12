import { RolesService } from '../roles/roles.service';
import { enteredAsSystem } from '@request-management/share';
import type { KeycloakJwtPayload } from '../auth/strategies/jwt.strategy';
import { PrincipalService } from './principal.service';

const ADMIN_PERMISSIONS = ['admin.org.manage', 'request.read.all'];

function serviceFor(options: {
  systemPermissions: string[];
  company?: {
    id: string;
    name: string;
    docPrefix: string;
    active: boolean;
  } | null;
}) {
  const user = {
    id: 'u-1',
    keycloakId: 'kc-1',
    username: 'request-admin',
    displayName: 'Request Admin',
    email: null,
    orgUnitId: 'unit-osd',
    supervisorUserId: null,
    lastCompanyId: null,
    primaryCompanyId: 'osd',
    status: 'ACTIVE',
  };
  const org = {
    companiesForUser: jest.fn().mockResolvedValue([
      {
        company: { id: 'osd', name: 'OSD', docPrefix: 'OSD' },
        isPrimary: true,
      },
    ]),
    findCompany: jest
      .fn()
      .mockResolvedValue(
        options.company === undefined
          ? { id: 'bco', name: 'BCO', docPrefix: 'BCO', active: true }
          : options.company,
      ),
    ledUnitIdsOf: jest.fn().mockResolvedValue([]),
    levelUnitIdsOf: jest.fn().mockResolvedValue([]),
    scopedAccessOf: jest.fn().mockResolvedValue({
      readUnits: [],
      actUnits: [],
      readUsers: [],
      actUsers: [],
      byPermission: {},
    }),
  };
  const roles = {
    rolesForUser: jest.fn().mockResolvedValue([]),
    effectivePermissions: jest.fn(
      (
        _u: string,
        _c: string,
        held: Parameters<typeof RolesService.permissionsOf>[0],
      ) => Promise.resolve(RolesService.permissionsOf(held)),
    ),
    systemPermissionsOf: jest.fn().mockResolvedValue(options.systemPermissions),
    adminPermissionsOf: jest.fn().mockResolvedValue(ADMIN_PERMISSIONS),
  };
  const service = new PrincipalService(
    {
      upsertFromClaims: jest
        .fn()
        .mockResolvedValue({ user, relinkedFrom: null }),
    } as never,
    org as never,
    roles as never,
    {
      resolveVisibleSensitiveFields: jest.fn().mockResolvedValue([]),
      listAllSensitiveFieldKeys: jest.fn().mockResolvedValue([]),
    } as never,
    { get: () => 'request-form' } as never,
    { record: jest.fn() } as never,
  );
  return { service, roles };
}

const payload = {
  sub: 'kc-1',
  preferred_username: 'request-admin',
} as unknown as KeycloakJwtPayload;

describe('P6 (Q2) — a system admin enters a company they do not belong to', () => {
  it('acts there with that company admin role, not their own grants', async () => {
    const { service, roles } = serviceFor({
      systemPermissions: ['system.tenant.read'],
    });

    const principal = await service.resolve(payload, 'bco');

    expect(principal.activeCompanyId).toBe('bco');
    expect(principal.permissions).toEqual(ADMIN_PERMISSIONS);
    expect(principal.roles).toEqual(['admin']);
    expect(principal.orgUnitId).toBeNull();
    expect(enteredAsSystem(principal)).toBe(true);
    expect(principal.companies.map((c) => [c.id, c.via])).toEqual([
      ['osd', undefined],
      ['bco', 'system'],
    ]);
    expect(roles.adminPermissionsOf).toHaveBeenCalledWith('bco');
    expect(roles.rolesForUser).not.toHaveBeenCalled();
  });

  it('without system.tenant.read the request falls back to a membership', async () => {
    const { service } = serviceFor({ systemPermissions: ['system.user.read'] });

    const principal = await service.resolve(payload, 'bco');

    expect(principal.activeCompanyId).toBe('osd');
    expect(principal.companies.map((c) => c.id)).toEqual(['osd']);
    expect(enteredAsSystem(principal)).toBe(false);
  });

  it('a closed company cannot be entered', async () => {
    const { service } = serviceFor({
      systemPermissions: ['system.tenant.read'],
      company: { id: 'bco', name: 'BCO', docPrefix: 'BCO', active: false },
    });

    const principal = await service.resolve(payload, 'bco');

    expect(principal.activeCompanyId).toBe('osd');
  });

  it('a company they belong to resolves as a member, not through the system plane', async () => {
    const { service } = serviceFor({
      systemPermissions: ['system.tenant.read'],
    });

    const principal = await service.resolve(payload, 'osd');

    expect(principal.activeCompanyId).toBe('osd');
    expect(enteredAsSystem(principal)).toBe(false);
  });
});
