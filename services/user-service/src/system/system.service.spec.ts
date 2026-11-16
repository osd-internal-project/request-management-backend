import type { Principal } from '@request-management/share';
import { RolesService } from '../roles/roles.service';
import { SystemService } from './system.service';

const SYSADMIN = {
  userId: 'sys-1',
  username: 'request_admin',
  activeCompanyId: 'company-osd',
  permissions: [],
  systemPermissions: ['system.user.manage', 'system.role.manage'],
  isServiceAccount: false,
} as unknown as Principal;

const tx = {
  execute: jest.fn((work: (client: unknown) => unknown) => work({})),
};

function userRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-1',
    status: 'ACTIVE',
    suspendReason: null,
    primaryCompanyId: 'company-osd',
    companies: [{ isPrimary: true, company: { id: 'company-osd' } }],
    systemRoles: [],
    ...overrides,
  };
}

function build(options: {
  user?: ReturnType<typeof userRow> | null;
  managersLeft?: number;
  sharedRole?: Record<string, unknown> | null;
  companiesFound?: number;
}) {
  const system = {
    findUser: jest.fn(() =>
      Promise.resolve(options.user === undefined ? userRow() : options.user),
    ),
    setStatus: jest.fn(() => Promise.resolve({ id: 'user-1' })),
    setPrimaryCompany: jest.fn(() => Promise.resolve({ id: 'user-1' })),
    countRoleManagers: jest.fn(() =>
      Promise.resolve(options.managersLeft ?? 1),
    ),
    findSharedRole: jest.fn(() => Promise.resolve(options.sharedRole ?? null)),
    findSharedRoleByCode: jest.fn(() => Promise.resolve(null)),
    findCompaniesByIds: jest.fn((ids: string[]) =>
      Promise.resolve(
        ids
          .slice(0, options.companiesFound ?? ids.length)
          .map((id) => ({ id })),
      ),
    ),
    grantSystemRole: jest.fn(() => Promise.resolve({})),
    revokeSystemRole: jest.fn(() => Promise.resolve({ count: 1 })),
  };
  const roles = { createRole: jest.fn(() => Promise.resolve({ id: 'r1' })) };
  const memberships = {
    detachFromCompany: jest.fn(() => Promise.resolve()),
    replaceForUser: jest.fn(() => Promise.resolve()),
  };
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const service = new SystemService(
    system as never,
    roles as never,
    {} as RolesService,
    memberships as never,
    audit as never,
    tx as never,
  );
  return { service, system, roles, memberships, audit };
}

describe('P5 SystemService', () => {
  it('suspends with a reason and writes the audit row in the same tx', async () => {
    const { service, system, audit } = build({});

    await service.suspend('user-1', { reason: ' ลาออก ' }, SYSADMIN);

    expect(system.setStatus).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        status: 'SUSPENDED',
        suspendedBy: 'sys-1',
        suspendReason: 'ลาออก',
      }),
      expect.anything(),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'system.user.suspended' }),
      expect.objectContaining({ prisma: expect.anything() }),
    );
  });

  it('refuses to suspend yourself', async () => {
    const { service } = build({});

    await expect(
      service.suspend('sys-1', { reason: 'x' }, SYSADMIN),
    ).rejects.toMatchObject({ code: 'UNPROCESSABLE' });
  });

  it('refuses to suspend the last person who manages system roles', async () => {
    const { service, system } = build({
      user: userRow({ systemRoles: [{ role: { id: 'r-sys' } }] }),
      managersLeft: 0,
    });

    await expect(
      service.suspend('user-1', { reason: 'x' }, SYSADMIN),
    ).rejects.toMatchObject({ code: 'UNPROCESSABLE' });
    expect(system.setStatus).not.toHaveBeenCalled();
  });

  it('refuses to revoke the last system-role manager', async () => {
    const { service, system } = build({
      sharedRole: { id: 'r-sys', level: 'SYSTEM', code: 'system_admin' },
      managersLeft: 0,
    });

    await expect(
      service.revokeSystemRole('user-1', 'r-sys', SYSADMIN),
    ).rejects.toMatchObject({ code: 'UNPROCESSABLE' });
    expect(system.revokeSystemRole).not.toHaveBeenCalled();
  });

  it('grants only an active SYSTEM role — a template answers 404', async () => {
    const { service, system } = build({
      sharedRole: { id: 'r-tpl', level: 'COMPANY', active: true },
    });

    await expect(
      service.grantSystemRole('user-1', 'r-tpl', SYSADMIN),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(system.grantSystemRole).not.toHaveBeenCalled();
  });

  it('a SYSTEM role may not carry a company permission (422)', async () => {
    const { service, roles } = build({});

    await expect(
      service.createSharedRole(
        {
          level: 'SYSTEM',
          code: 'x',
          name: 'x',
          permissions: ['system.user.read', 'user.read'],
        },
        SYSADMIN,
      ),
    ).rejects.toMatchObject({ code: 'UNPROCESSABLE' });
    expect(roles.createRole).not.toHaveBeenCalled();
  });

  it('a template role may not carry system.* (422)', async () => {
    const { service } = build({});

    await expect(
      service.createSharedRole(
        {
          level: 'COMPANY',
          code: 'x',
          name: 'x',
          permissions: ['user.read', 'system.tenant.read'],
        },
        SYSADMIN,
      ),
    ).rejects.toMatchObject({ code: 'UNPROCESSABLE' });
  });

  it('moving companies detaches only the dropped one', async () => {
    const { service, memberships } = build({
      user: userRow({
        companies: [
          { isPrimary: true, company: { id: 'company-osd' } },
          { isPrimary: false, company: { id: 'company-demo' } },
        ],
      }),
    });

    await service.replaceCompanies(
      'user-1',
      { company_ids: ['company-osd', 'company-new'] },
      SYSADMIN,
    );

    expect(memberships.detachFromCompany).toHaveBeenCalledTimes(1);
    expect(memberships.detachFromCompany).toHaveBeenCalledWith(
      'user-1',
      'company-demo',
      expect.anything(),
    );
    expect(memberships.replaceForUser).toHaveBeenCalledWith(
      'user-1',
      ['company-osd', 'company-new'],
      'company-osd',
      expect.anything(),
    );
  });

  it('an unknown company answers 404 and changes nothing', async () => {
    const { service, memberships } = build({ companiesFound: 0 });

    await expect(
      service.replaceCompanies('user-1', { company_ids: ['nope'] }, SYSADMIN),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(memberships.detachFromCompany).not.toHaveBeenCalled();
  });
});

describe('company bootstrap + overview (14 พ.ย. 2569)', () => {
  function companies(user: Record<string, unknown> | null = null) {
    const system = {
      findCompanyByCode: jest.fn(() => Promise.resolve(null)),
      createCompany: jest.fn(() =>
        Promise.resolve({ id: 'co-new', code: 'NEWCO', name: 'New Co' }),
      ),
      bootstrapCompany: jest.fn(() =>
        Promise.resolve({ roleId: 'role-admin', rootUnitId: 'unit-root' }),
      ),
      findUser: jest.fn(() => Promise.resolve(user)),
      addCompanyAdmin: jest.fn(() => Promise.resolve()),
      listCompanies: jest.fn(() =>
        Promise.resolve([
          { id: 'co-a', code: 'A', _count: { users: 3, orgUnits: 2 } },
          { id: 'co-b', code: 'B', _count: { users: 1, orgUnits: 1 } },
        ]),
      ),
      suspendedMembersByCompany: jest.fn(() =>
        Promise.resolve([{ companyId: 'co-a', _count: { _all: 1 } }]),
      ),
      adminHolders: jest.fn(() =>
        Promise.resolve([
          { companyId: 'co-a', user: { id: 'u1' } },
          { companyId: 'co-a', user: { id: 'u2' } },
        ]),
      ),
    };
    const audit = { record: jest.fn(() => Promise.resolve()) };
    const service = new SystemService(
      system as never,
      {} as never,
      {} as RolesService,
      {} as never,
      audit as never,
      tx as never,
    );
    return { service, system, audit };
  }
  const dto = { code: 'NEWCO', name: ' New Co ', doc_prefix: 'NC' };

  it('creates the admin role (no approval right) and a root unit with the company', async () => {
    const { service, system } = companies();
    await service.createCompany(dto, SYSADMIN);

    const [, permissions] = system.bootstrapCompany.mock.calls[0] as unknown as [
      unknown,
      string[],
    ];
    expect(permissions).toContain('admin.integration.manage');
    expect(permissions).not.toContain('approval.decide');
    expect(permissions).not.toContain('request.sensitive.read');
    expect(system.addCompanyAdmin).not.toHaveBeenCalled();
  });

  it('makes the named person the first admin', async () => {
    const { service, system } = companies({ id: 'u9', status: 'ACTIVE' });
    await service.createCompany({ ...dto, admin_user_id: 'u9' }, SYSADMIN);
    expect(system.addCompanyAdmin).toHaveBeenCalledWith(
      'u9',
      'co-new',
      'role-admin',
      'sys-1',
      expect.anything(),
    );
  });

  it('refuses a suspended first admin', async () => {
    const { service, system } = companies({ id: 'u9', status: 'SUSPENDED' });
    await expect(
      service.createCompany({ ...dto, admin_user_id: 'u9' }, SYSADMIN),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(system.addCompanyAdmin).not.toHaveBeenCalled();
  });

  it('overview counts suspended members and admins per company', async () => {
    const { service } = companies();
    const rows = await service.listCompanies();
    expect(
      rows.map(({ code, suspendedMembers, adminCount }) => ({
        code,
        suspendedMembers,
        adminCount,
      })),
    ).toEqual([
      { code: 'A', suspendedMembers: 1, adminCount: 2 },
      { code: 'B', suspendedMembers: 0, adminCount: 0 },
    ]);
  });
});
