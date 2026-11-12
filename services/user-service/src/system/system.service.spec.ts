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
