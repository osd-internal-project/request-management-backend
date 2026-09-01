import { AppError } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { OrgService } from './org.service';

const OSD = 'company-osd';
const UNIT = 'unit-1';

function actor(): Principal {
  return {
    userId: 'admin-1',
    username: 'admin',
    activeCompanyId: OSD,
    permissions: ['admin.org.manage'],
    // Only the fields this path reads. Double cast because a partial
    // principal no longer overlaps the full one enough for a single one.
  } as unknown as Principal;
}

type Dependents = {
  members: number;
  children: number;
  receivedTypes: number;
  biAudiences: number;
};

/**
 * Builds the service with only the collaborators `deleteUnit` reaches, and
 * reports what it wrote — the point of these tests is *whether the delete
 * happened*, which is decided before any database is involved.
 */
function serviceWith(options: {
  dependents?: Dependents;
  unit?: { id: string; companyId: string } | null;
}) {
  const deleteUnit = jest.fn(() => Promise.resolve({}));
  const audit = jest.fn(() => Promise.resolve({}));

  const service = new OrgService(
    {} as never,
    {
      findById: jest.fn(() =>
        Promise.resolve(
          options.unit === undefined
            ? { id: UNIT, companyId: OSD, name: 'ฝ่ายขาย' }
            : options.unit,
        ),
      ),
      countDependents: jest.fn(() =>
        Promise.resolve(
          options.dependents ?? {
            members: 0,
            children: 0,
            receivedTypes: 0,
            biAudiences: 0,
          },
        ),
      ),
      deleteUnit,
      findAllForClosure: jest.fn(() => Promise.resolve([])),
    } as never,
    { rebuildForCompany: jest.fn(() => Promise.resolve()) } as never,
    {} as never,
    {} as never,
    {} as never,
    { record: audit } as never,
    {
      execute: jest.fn((work: (client: unknown) => unknown) => work({})),
    } as never,
  );

  return { service, deleteUnit, audit };
}

describe('AUTH-04: a group may be deleted only while nothing points at it', () => {
  it('deletes a group nothing references', async () => {
    const { service, deleteUnit, audit } = serviceWith({});

    await service.deleteUnit(UNIT, actor());

    expect(deleteUnit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledTimes(1);
  });

  /*
    Each blocker is reported by name. "Cannot delete" on its own sends an admin
    hunting through the chart to find out why, which is the failure this
    message exists to prevent.
  */
  it.each([
    ['members', { members: 3 }],
    ['children', { children: 1 }],
    ['request_types', { receivedTypes: 2 }],
    ['bi_audiences', { biAudiences: 1 }],
  ])('refuses and names the blocker: %s', async (field, counts) => {
    const { service, deleteUnit } = serviceWith({
      dependents: {
        members: 0,
        children: 0,
        receivedTypes: 0,
        biAudiences: 0,
        ...counts,
      },
    });

    await service.deleteUnit(UNIT, actor()).catch((error: AppError) => {
      expect(error.code).toBe('ORG_UNIT_IN_USE');
      expect(error.details?.map((detail) => detail.field)).toContain(field);
    });

    expect(deleteUnit).not.toHaveBeenCalled();
    expect.assertions(3);
  });

  it('lists every blocker at once rather than one per attempt', async () => {
    const { service } = serviceWith({
      dependents: {
        members: 2,
        children: 1,
        receivedTypes: 0,
        biAudiences: 0,
      },
    });

    await service.deleteUnit(UNIT, actor()).catch((error: AppError) => {
      expect(error.details).toHaveLength(2);
    });

    expect.assertions(1);
  });

  it('answers NOT_FOUND for a group that is not there', async () => {
    const { service, deleteUnit } = serviceWith({ unit: null });

    await service.deleteUnit(UNIT, actor()).catch((error: AppError) => {
      expect(error.code).toBe('NOT_FOUND');
    });

    expect(deleteUnit).not.toHaveBeenCalled();
    expect.assertions(2);
  });
});
