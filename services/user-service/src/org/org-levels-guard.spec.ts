import { AppError } from '@request-management/share';
import type { Principal } from '@request-management/share';
import type { OrgUnit } from '@prisma/client';
import { OrgService } from './org.service';

const OSD = 'company-osd';

function actor(): Principal {
  return {
    userId: 'admin-1',
    username: 'admin',
    activeCompanyId: OSD,
    permissions: ['admin.org.manage'],
    // Only the fields these paths read. Double cast because a partial
    // principal no longer overlaps the full one enough for a single one.
  } as unknown as Principal;
}

function unit(overrides: Partial<OrgUnit>): OrgUnit {
  return {
    id: 'unit-1',
    companyId: OSD,
    code: 'U1',
    name: 'หน่วยงาน',
    kind: 'DEPARTMENT',
    parentId: null,
    managerUserId: null,
    active: true,
    ...overrides,
  } as OrgUnit;
}

/**
 * The service with only the collaborators these two paths reach. Every check
 * under test happens before a database is involved, so the repositories only
 * have to answer "what is this unit".
 */
function serviceWith(options: {
  units?: Record<string, OrgUnit>;
  childKinds?: OrgUnit['kind'][];
  user?: { id: string; orgUnitId: string | null; primaryCompanyId: string };
}) {
  const createUnit = jest.fn((data: unknown) => Promise.resolve(data));
  const updateUnit = jest.fn((_id: string, data: unknown) =>
    Promise.resolve({ ...unit({}), ...(data as object) }),
  );
  const assignOrg = jest.fn(() =>
    Promise.resolve({ id: 'user-1', orgUnitId: null, primaryCompanyId: OSD }),
  );

  const service = new OrgService(
    {} as never,
    {
      findById: jest.fn((id: string) =>
        Promise.resolve(options.units?.[id] ?? null),
      ),
      childKindsOf: jest.fn(() => Promise.resolve(options.childKinds ?? [])),
      createUnit,
      updateUnit,
      findAllForClosure: jest.fn(() => Promise.resolve([])),
    } as never,
    { rebuildForCompany: jest.fn(() => Promise.resolve()), descendantIdsOf: jest.fn(() => Promise.resolve([])) } as never,
    {} as never,
    {} as never,
    {
      findById: jest.fn(() =>
        Promise.resolve(
          options.user ?? { id: 'user-1', orgUnitId: null, primaryCompanyId: OSD },
        ),
      ),
      assignOrg,
    } as never,
    {} as never,
    { record: jest.fn(() => Promise.resolve({})) } as never,
    {
      execute: jest.fn((work: (client: unknown) => unknown) => work({})),
    } as never,
  );

  return { service, createUnit, updateUnit, assignOrg };
}

const COMPANY = unit({ id: 'company', code: 'ROOT', kind: 'COMPANY' });
const DIVISION = unit({ id: 'division', code: 'INF', kind: 'DIVISION' });
const DEPARTMENT = unit({ id: 'department', code: 'RND', kind: 'DEPARTMENT' });
const POSITION = unit({ id: 'position', code: 'DEV', kind: 'POSITION' });

const UNITS = {
  company: COMPANY,
  division: DIVISION,
  department: DEPARTMENT,
  position: POSITION,
};

describe('the chart is five adjacent levels', () => {
  it('creates a unit one level under its parent', async () => {
    const { service, createUnit } = serviceWith({ units: UNITS });

    await service.createUnit(
      { company_id: OSD, code: 'DEV1', name: 'ทีมพัฒนา', kind: 'TEAM', parent_id: 'department' },
      actor(),
    );

    expect(createUnit).toHaveBeenCalledTimes(1);
    expect(createUnit.mock.calls[0][0]).toMatchObject({ kind: 'TEAM' });
  });

  /*
    Screen A3 has always sent `kind: "TEAM"` for every new box regardless of
    where it was dropped. With no level named, the level that fits is the only
    sensible reading — and it is the one that keeps that screen working.
  */
  it('derives the level from the parent when none is given', async () => {
    const { service, createUnit } = serviceWith({ units: UNITS });

    await service.createUnit(
      { company_id: OSD, code: 'SAL', name: 'ฝ่ายขาย', parent_id: 'company' },
      actor(),
    );

    expect(createUnit.mock.calls[0][0]).toMatchObject({ kind: 'DIVISION' });
  });

  it('refuses a skipped level', async () => {
    const { service, createUnit } = serviceWith({ units: UNITS });

    await service
      .createUnit(
        { company_id: OSD, code: 'RND', name: 'แผนก', kind: 'DEPARTMENT', parent_id: 'company' },
        actor(),
      )
      .catch((error: AppError) => {
        expect(error.code).toBe('ORG_UNIT_LEVEL_INVALID');
        expect(error.message).toContain('ฝ่าย');
      });

    expect(createUnit).not.toHaveBeenCalled();
    expect.assertions(3);
  });

  it('refuses a sub-unit under the deepest level', async () => {
    const { service, createUnit } = serviceWith({ units: UNITS });

    await service
      .createUnit(
        { company_id: OSD, code: 'X', name: 'ย่อย', parent_id: 'position' },
        actor(),
      )
      .catch((error: AppError) => {
        expect(error.code).toBe('ORG_UNIT_LEVEL_INVALID');
      });

    expect(createUnit).not.toHaveBeenCalled();
    expect.assertions(2);
  });

  it('refuses a level that does not fit the parent it keeps', async () => {
    const { service, updateUnit } = serviceWith({
      units: {
        ...UNITS,
        department: unit({ id: 'department', kind: 'DEPARTMENT', parentId: 'division' }),
      },
    });

    await service
      .updateUnit('department', { kind: 'DIVISION' }, actor())
      .catch((error: AppError) => {
        expect(error.code).toBe('ORG_UNIT_LEVEL_INVALID');
        expect(error.message).toContain('บริษัท');
      });

    expect(updateUnit).not.toHaveBeenCalled();
    expect.assertions(3);
  });

  /*
    Moving a แผนก up to be a ฝ่าย fits the บริษัท it lands under, so the parent
    check passes — and its ทีม, which do not move, end up two levels down with
    nothing in between. The children are the only thing that catches this.
  */
  it('refuses raising a level while children stay where they are', async () => {
    const { service, updateUnit } = serviceWith({
      units: {
        ...UNITS,
        department: unit({ id: 'department', kind: 'DEPARTMENT', parentId: 'division' }),
      },
      childKinds: ['TEAM'],
    });

    await service
      .updateUnit(
        'department',
        { kind: 'DIVISION', parent_id: 'company' },
        actor(),
      )
      .catch((error: AppError) => {
        expect(error.code).toBe('ORG_UNIT_LEVEL_INVALID');
        expect(error.message).toContain('ทีม');
      });

    expect(updateUnit).not.toHaveBeenCalled();
    expect.assertions(3);
  });

  /*
    A chart built before these rules keeps its shape. Refusing every edit to a
    company whose existing units break them would lock that company out of the
    screen it needs in order to fix them.
  */
  it('leaves an existing unit alone while nothing about its level changes', async () => {
    const { service, updateUnit } = serviceWith({
      units: { ...UNITS, department: unit({ id: 'department', kind: 'DEPARTMENT', parentId: 'company' }) },
    });

    await service.updateUnit('department', { name: 'ชื่อใหม่' }, actor());

    expect(updateUnit).toHaveBeenCalledTimes(1);
  });
});

describe('people sit at แผนก or below', () => {
  it.each([
    ['company', 'บริษัท'],
    ['division', 'ฝ่าย'],
  ])('refuses assigning somebody to a %s unit', async (id, label) => {
    const { service, assignOrg } = serviceWith({ units: UNITS });

    await service
      .assignUser('user-1', { org_unit_id: id }, actor())
      .catch((error: AppError) => {
        expect(error.code).toBe('ORG_UNIT_CANNOT_HOLD_MEMBERS');
        expect(error.message).toContain(label);
      });

    expect(assignOrg).not.toHaveBeenCalled();
    expect.assertions(3);
  });

  it.each(['department', 'position'])('assigns somebody to a %s unit', async (id) => {
    const { service, assignOrg } = serviceWith({ units: UNITS });

    await service.assignUser('user-1', { org_unit_id: id }, actor());

    expect(assignOrg).toHaveBeenCalledTimes(1);
  });
});
