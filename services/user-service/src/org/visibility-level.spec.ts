import type { OrgUnitKind } from '@prisma/client';
import { OrgService } from './org.service';

const OSD = 'company-osd';
const OTHER = 'company-bco';

/**
 *   ou_company  (COMPANY)
 *     └── ou_inf      (DIVISION)
 *           ├── ou_rnd      (DEPARTMENT)
 *           │     └── ou_dev      (POSITION)
 *           └── ou_ops      (DEPARTMENT)
 *     └── ou_sales    (DIVISION)
 */
const KIND_OF: Record<string, OrgUnitKind> = {
  ou_company: 'COMPANY',
  ou_inf: 'DIVISION',
  ou_rnd: 'DEPARTMENT',
  ou_dev: 'POSITION',
  ou_ops: 'DEPARTMENT',
  ou_sales: 'DIVISION',
};

const SUBTREE: Record<string, string[]> = {
  ou_company: [
    'ou_company',
    'ou_inf',
    'ou_rnd',
    'ou_dev',
    'ou_ops',
    'ou_sales',
  ],
  ou_inf: ['ou_inf', 'ou_rnd', 'ou_dev', 'ou_ops'],
  ou_rnd: ['ou_rnd', 'ou_dev'],
  ou_ops: ['ou_ops'],
  ou_dev: ['ou_dev'],
  ou_sales: ['ou_sales'],
};

/** Nearest first, as `ancestorsOf` returns them. */
const ANCESTORS: Record<string, string[]> = {
  ou_dev: ['ou_dev', 'ou_rnd', 'ou_inf', 'ou_company'],
  ou_ops: ['ou_ops', 'ou_inf', 'ou_company'],
};

/**
 * Builds the service with only the two repositories `levelUnitIdsOf` reaches.
 *
 * `companyOf` decides which ancestors the unit lookup admits, so a person whose
 * home unit sits in another company can be told apart from one whose does not —
 * SCOPE-03 is the reason the lookup filters at all.
 */
function serviceWith(companyOf: Record<string, string> = {}) {
  const descendantIdsOf = jest.fn((id: string) =>
    Promise.resolve(SUBTREE[id] ?? [id]),
  );

  const service = new OrgService(
    {} as never,
    {
      findMany: jest.fn(
        (args: { where: { id: { in: string[] }; companyId: string } }) =>
          Promise.resolve(
            args.where.id.in
              .filter((id) => (companyOf[id] ?? OSD) === args.where.companyId)
              .map((id) => ({ id, kind: KIND_OF[id] })),
          ),
      ),
    } as never,
    {
      ancestorsOf: jest.fn((id: string) =>
        Promise.resolve(
          (ANCESTORS[id] ?? [id]).map((ancestorId, depth) => ({
            ancestorId,
            depth,
          })),
        ),
      ),
      descendantIdsOf,
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  return { service, descendantIdsOf };
}

describe('Role.visibilityLevel — how far up the holder’s own branch a view starts', () => {
  it('reaches the subtree of the nearest ancestor at that level', async () => {
    const { service } = serviceWith();

    await expect(
      service.levelUnitIdsOf('ou_dev', OSD, ['DEPARTMENT']),
    ).resolves.toEqual(expect.arrayContaining(['ou_rnd', 'ou_dev']));
  });

  it('resolves the same level to a different branch for a different holder', async () => {
    const { service } = serviceWith();

    const inRnd = await service.levelUnitIdsOf('ou_dev', OSD, ['DEPARTMENT']);
    const inOps = await service.levelUnitIdsOf('ou_ops', OSD, ['DEPARTMENT']);

    // The point of a relative level: one role, two answers. A
    // `(role, resource) → level` rule could not tell these two apart.
    expect(inRnd).toContain('ou_rnd');
    expect(inRnd).not.toContain('ou_ops');
    expect(inOps).toEqual(['ou_ops']);
  });

  it('widens to the division when the level names one', async () => {
    const { service } = serviceWith();

    await expect(
      service.levelUnitIdsOf('ou_dev', OSD, ['DIVISION']),
    ).resolves.toEqual(
      expect.arrayContaining(['ou_inf', 'ou_rnd', 'ou_dev', 'ou_ops']),
    );
  });

  it('never crosses into another branch at the same level', async () => {
    const { service } = serviceWith();

    await expect(
      service.levelUnitIdsOf('ou_dev', OSD, ['DIVISION']),
    ).resolves.not.toContain('ou_sales');
  });

  it('reaches nothing when no ancestor carries that kind', async () => {
    const { service, descendantIdsOf } = serviceWith();

    // What the day POSITION nodes leave the chart looks like: the role goes
    // quiet instead of widening to the department above it.
    await expect(
      service.levelUnitIdsOf('ou_ops', OSD, ['POSITION']),
    ).resolves.toEqual([]);
    expect(descendantIdsOf).not.toHaveBeenCalled();
  });

  it('unions several roles and reads each root once', async () => {
    const { service, descendantIdsOf } = serviceWith();

    const reached = await service.levelUnitIdsOf('ou_dev', OSD, [
      'DEPARTMENT',
      'DIVISION',
      'DEPARTMENT',
    ]);

    expect(reached).toEqual(
      expect.arrayContaining(['ou_inf', 'ou_rnd', 'ou_dev', 'ou_ops']),
    );
    expect(new Set(reached).size).toBe(reached.length);
    expect(descendantIdsOf).toHaveBeenCalledTimes(2);
  });

  it('reaches nothing for somebody with no unit or no level', async () => {
    const { service } = serviceWith();

    await expect(
      service.levelUnitIdsOf(null, OSD, ['COMPANY']),
    ).resolves.toEqual([]);
    await expect(service.levelUnitIdsOf('ou_dev', OSD, [])).resolves.toEqual(
      [],
    );
  });

  it('SCOPE-03: ancestors in another company are not reachable from this one', async () => {
    const { service } = serviceWith({ ou_company: OTHER, ou_inf: OTHER });

    await expect(
      service.levelUnitIdsOf('ou_dev', OSD, ['DIVISION']),
    ).resolves.toEqual([]);
  });
});
