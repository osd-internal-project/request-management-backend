import type { Principal } from '@request-management/share';
import type { OrgUnit, Role } from '@prisma/client';
import { RolesService } from '../roles/roles.service';
import { OrgService } from './org.service';

const OSD = 'company-osd';
const OTHER = 'company-other';

function adminOf(...companies: string[]): Principal {
  return {
    userId: 'admin-1',
    username: 'admin',
    activeCompanyId: companies[0],
    companies: companies.map((id) => ({ id })),
    permissions: ['admin.org.manage', 'admin.role.manage'],
    isServiceAccount: false,
  } as unknown as Principal;
}

function unitIn(companyId: string, overrides: Partial<OrgUnit> = {}): OrgUnit {
  return {
    id: `unit-${companyId}`,
    companyId,
    code: 'U1',
    name: 'หน่วยงาน',
    kind: 'DEPARTMENT',
    parentId: null,
    managerUserId: null,
    active: true,
    ...overrides,
  } as OrgUnit;
}

const tx = {
  execute: jest.fn((work: (client: unknown) => unknown) => work({})),
};
const audit = { record: jest.fn(() => Promise.resolve({})) };

function orgService(options: {
  units?: Record<string, OrgUnit>;
  userCompanies?: string[];
  supervisorFound?: boolean;
}) {
  const replaceForUser = jest.fn(() => Promise.resolve());
  const assignOrg = jest.fn(() =>
    Promise.resolve({ id: 'user-1', orgUnitId: null, primaryCompanyId: OSD }),
  );
  const updateUnit = jest.fn(() => Promise.resolve(unitIn(OSD)));

  const service = new OrgService(
    {} as never,
    {
      findById: jest.fn((id: string) =>
        Promise.resolve(options.units?.[id] ?? null),
      ),
      childKindsOf: jest.fn(() => Promise.resolve([])),
      countDependents: jest.fn(() => Promise.resolve({})),
      updateUnit,
    } as never,
    { rebuildForCompany: jest.fn(() => Promise.resolve()) } as never,
    {} as never,
    {
      companyIdsOf: jest.fn(() => Promise.resolve(options.userCompanies ?? [])),
      replaceForUser,
    } as never,
    {
      findById: jest.fn(() =>
        Promise.resolve({
          id: 'user-1',
          orgUnitId: null,
          primaryCompanyId: null,
        }),
      ),
      findFirst: jest.fn(() =>
        Promise.resolve(
          options.supervisorFound === false ? null : { id: 'sup' },
        ),
      ),
      assignOrg,
    } as never,
    {} as never,
    audit as never,
    tx as never,
  );

  return { service, replaceForUser, assignOrg, updateUnit };
}

describe('SCOPE-03 an admin writes only inside companies they belong to', () => {
  describe('assignUser', () => {
    it('answers 404 for somebody who belongs only to another company', async () => {
      const { service, assignOrg } = orgService({ userCompanies: [OTHER] });

      await expect(
        service.assignUser('user-1', {}, adminOf(OSD)),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(assignOrg).not.toHaveBeenCalled();
    });

    it('refuses to attach somebody to a company the admin is not in', async () => {
      const { service, replaceForUser } = orgService({ userCompanies: [] });

      await expect(
        service.assignUser('user-1', { companies: [OTHER] }, adminOf(OSD)),
      ).rejects.toMatchObject({ code: 'COMPANY_FORBIDDEN' });
      expect(replaceForUser).not.toHaveBeenCalled();
    });

    it('keeps memberships in companies the admin is not in', async () => {
      const { service, replaceForUser } = orgService({
        userCompanies: [OSD, OTHER],
      });

      await service.assignUser('user-1', { companies: [OSD] }, adminOf(OSD));

      expect(replaceForUser).toHaveBeenCalledWith(
        'user-1',
        [OTHER, OSD],
        OSD,
        expect.anything(),
      );
    });

    it('takes a new person from the unassigned queue into the admin company', async () => {
      const { service, replaceForUser } = orgService({ userCompanies: [] });

      await service.assignUser('user-1', { companies: [OSD] }, adminOf(OSD));

      expect(replaceForUser).toHaveBeenCalledWith(
        'user-1',
        [OSD],
        OSD,
        expect.anything(),
      );
    });

    it('answers 404 for a unit in another company', async () => {
      const { service, assignOrg } = orgService({
        userCompanies: [OSD],
        units: { foreign: unitIn(OTHER, { id: 'foreign' }) },
      });

      await expect(
        service.assignUser('user-1', { org_unit_id: 'foreign' }, adminOf(OSD)),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(assignOrg).not.toHaveBeenCalled();
    });

    it('answers 404 for a supervisor outside the companies being assigned', async () => {
      const { service, assignOrg } = orgService({
        userCompanies: [OSD],
        supervisorFound: false,
      });

      await expect(
        service.assignUser(
          'user-1',
          { supervisor_user_id: 'stranger' },
          adminOf(OSD),
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(assignOrg).not.toHaveBeenCalled();
    });
  });

  describe('org units', () => {
    it('refuses to create a unit in another company', async () => {
      const { service } = orgService({});

      await expect(
        service.createUnit(
          { company_id: OTHER, code: 'X', name: 'X' } as never,
          adminOf(OSD),
        ),
      ).rejects.toMatchObject({ code: 'COMPANY_FORBIDDEN' });
    });

    it.each(['updateUnit', 'deleteUnit'] as const)(
      '%s answers 404 for a unit in another company',
      async (method) => {
        const { service, updateUnit } = orgService({
          units: { foreign: unitIn(OTHER, { id: 'foreign' }) },
        });

        const call =
          method === 'updateUnit'
            ? service.updateUnit('foreign', { name: 'x' }, adminOf(OSD))
            : service.deleteUnit('foreign', adminOf(OSD));

        await expect(call).rejects.toMatchObject({ code: 'NOT_FOUND' });
        expect(updateUnit).not.toHaveBeenCalled();
      },
    );
  });
});

type RoleRow = Role & { permissions: { permissionCode: string }[] };

function role(companyId: string | null): RoleRow {
  return {
    id: 'role-1',
    companyId,
    code: 'sales',
    name: 'Sales',
    active: true,
    isSystem: false,
    level: 'COMPANY',
    permissions: [],
  } as unknown as RoleRow;
}

function rolesService(options: {
  role?: RoleRow | null;
  userCompanies?: string[];
  heldPermissions?: string[];
}) {
  const grant = jest.fn(() => Promise.resolve());
  const createRole = jest.fn((data: object) =>
    Promise.resolve({ id: 'new', ...data }),
  );
  const updateRole = jest.fn(() => Promise.resolve(role(OSD)));

  const service = new RolesService(
    {
      findById: jest.fn(() => Promise.resolve(options.role ?? null)),
      createRole,
      updateRole,
      countUsers: jest.fn(() => Promise.resolve(0)),
    } as never,
    {
      grant,
      findForUserInCompany: jest.fn(() =>
        Promise.resolve([
          {
            role: {
              permissions: (options.heldPermissions ?? []).map(
                (permissionCode) => ({
                  permissionCode,
                }),
              ),
            },
          },
        ]),
      ),
    } as never,
    {} as never,
    {} as never,
    audit as never,
    tx as never,
    {
      companyIdsOf: jest.fn(() => Promise.resolve(options.userCompanies ?? [])),
    } as never,
    { listLive: jest.fn().mockResolvedValue([]) } as never,
  );

  return { service, grant, createRole, updateRole };
}

describe('ROLE-04 roles stay inside the admin company', () => {
  it('creates a role in the active company when none is named', async () => {
    const { service, createRole } = rolesService({});

    await service.createRole(
      { code: 'x', name: 'X', permissions: [] } as never,
      adminOf(OSD),
    );

    expect(createRole).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: OSD }),
      [],
      expect.anything(),
    );
  });

  it('refuses to create a role in another company', async () => {
    const { service, createRole } = rolesService({});

    await expect(
      service.createRole(
        { company_id: OTHER, code: 'x', name: 'X', permissions: [] } as never,
        adminOf(OSD),
      ),
    ).rejects.toMatchObject({ code: 'COMPANY_FORBIDDEN' });
    expect(createRole).not.toHaveBeenCalled();
  });

  it.each([
    ['another company', OTHER],
    ['every company', null],
  ])('answers 404 when editing a role of %s', async (_label, companyId) => {
    const { service, updateRole } = rolesService({ role: role(companyId) });

    await expect(
      service.updateRole('role-1', { name: 'x' }, adminOf(OSD)),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(updateRole).not.toHaveBeenCalled();
  });

  it('answers 404 when binding another company role', async () => {
    const { service, grant } = rolesService({
      role: role(OTHER),
      userCompanies: [OSD],
    });

    await expect(
      service.grantRole('user-1', 'role-1', OSD, adminOf(OSD)),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(grant).not.toHaveBeenCalled();
  });

  it('answers 404 when the person is not in that company', async () => {
    const { service, grant } = rolesService({
      role: role(OSD),
      userCompanies: [OTHER],
    });

    await expect(
      service.grantRole('user-1', 'role-1', OSD, adminOf(OSD)),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(grant).not.toHaveBeenCalled();
  });

  it('binds a company role to a member of that company', async () => {
    const { service, grant } = rolesService({
      role: role(OSD),
      userCompanies: [OSD],
    });

    await service.grantRole('user-1', 'role-1', OSD, adminOf(OSD));

    expect(grant).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        roleId: 'role-1',
        companyId: OSD,
      }),
      expect.anything(),
    );
  });

  it('P7 — §5.4 is judged on what the person ends up holding (422)', async () => {
    const { service, grant } = rolesService({
      role: {
        ...role(OSD),
        permissions: [{ permissionCode: 'approval.decide' }],
      } as RoleRow,
      userCompanies: [OSD],
      heldPermissions: ['admin.org.manage'],
    });

    await expect(
      service.grantRole('user-1', 'role-1', OSD, adminOf(OSD)),
    ).rejects.toMatchObject({ code: 'UNPROCESSABLE' });
    expect(grant).not.toHaveBeenCalled();
  });

  it('P5 — a system role is not bindable from a company screen (404)', async () => {
    const { service, grant } = rolesService({
      role: { ...role(null), level: 'SYSTEM' } as RoleRow,
      userCompanies: [OSD],
    });

    await expect(
      service.grantRole('user-1', 'role-1', OSD, adminOf(OSD)),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(grant).not.toHaveBeenCalled();
  });
});
