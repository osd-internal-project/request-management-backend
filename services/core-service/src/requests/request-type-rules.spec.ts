import { AppError } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { RequestsService } from './requests.service';

const OSD = 'company-osd';

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    userId: 'user-1',
    username: 'somchai',
    activeCompanyId: OSD,
    orgUnitId: 'unit-position',
    permissions: ['request.create'],
    ...overrides,
    // Only the fields these paths read. Double cast because a partial
    // principal no longer overlaps the full one enough for a single one.
  } as unknown as Principal;
}

/**
 * Builds the service with only the collaborators the two paths under test
 * reach, and reports the `where` or the delete it would have issued.
 */
function serviceWith(options: {
  ancestors?: string[];
  requestCount?: number;
  matrixCount?: number;
  type?: { id: string; code: string; name: string } | null;
}) {
  /** Typed so the assertions below can read the `where` without `any`. */
  const findMany = jest.fn<
    Promise<unknown[]>,
    [{ where: { OR: Record<string, unknown>[] } }]
  >(() => Promise.resolve([]));
  const deleteType = jest.fn(() => Promise.resolve({}));

  const service = new RequestsService(
    {
      countWhere: jest.fn(() => Promise.resolve(options.requestCount ?? 0)),
    } as never,
    {} as never,
    // `RequestCommentRepository` — none of these paths comment.
    {} as never,
    {
      findMany,
      findFirst: jest.fn(() =>
        Promise.resolve(
          options.type === undefined
            ? { id: 'type-1', code: 'DSC', name: 'ขอส่วนลด' }
            : options.type,
        ),
      ),
    } as never,
    {
      ancestorIdsOf: jest.fn(() => Promise.resolve(options.ancestors ?? [])),
    } as never,
    {} as never,
    {
      countMatricesFor: jest.fn(() =>
        Promise.resolve(options.matrixCount ?? 0),
      ),
    } as never,
    // `SlaService` — listTypes asks which types are cases (CD-67).
    { caseTargetsOf: jest.fn(() => Promise.resolve(new Map())) } as never,
    {} as never,
    {} as never,
    { record: jest.fn(() => Promise.resolve()) } as never,
    {
      execute: jest.fn((work: (client: unknown) => unknown) =>
        work({ requestType: { delete: deleteType } }),
      ),
    } as never,
    {} as never, // flows
  );

  return { service, findMany, deleteType };
}

describe('REQ-01: which groups may raise a type', () => {
  /** The `OR` the eligibility rule contributes to the list query. */
  function eligibilityOf(
    findMany: ReturnType<typeof serviceWith>['findMany'],
  ): Record<string, unknown>[] {
    return findMany.mock.calls[0][0].where.OR;
  }

  it('offers a type with no groups named to everybody', async () => {
    const { service, findMany } = serviceWith({ ancestors: ['unit-position'] });

    await service.listTypes(principal());

    expect(eligibilityOf(findMany)).toContainEqual({
      eligibleUnits: { none: {} },
    });
  });

  /**
   * Naming a department has to reach the positions under it. Asked the other
   * way round — which groups is the requester beneath — so the query stays one
   * `IN` however many groups a type names.
   */
  it('matches a named group against every group the requester sits beneath', async () => {
    const ancestors = ['unit-position', 'unit-dept', 'unit-division', 'root'];
    const { service, findMany } = serviceWith({ ancestors });

    await service.listTypes(principal());

    expect(eligibilityOf(findMany)).toContainEqual({
      eligibleUnits: { some: { orgUnitId: { in: ancestors } } },
    });
  });

  /**
   * Somebody in the "รอจัดสังกัด" queue sits nowhere, so they match no named
   * group — and see only the types open to everybody, rather than all of them.
   */
  it('gives an unplaced requester an empty ancestor set, not a free pass', async () => {
    const { service, findMany } = serviceWith({});

    await service.listTypes(principal({ orgUnitId: null }));

    expect(eligibilityOf(findMany)).toContainEqual({
      eligibleUnits: { some: { orgUnitId: { in: [] } } },
    });
  });
});

describe('REQ-01: a type may be deleted only while nothing was raised against it', () => {
  it('deletes a type nothing references', async () => {
    const { service, deleteType } = serviceWith({});

    await service.deleteType('DSC', principal());

    expect(deleteType).toHaveBeenCalledTimes(1);
  });

  /*
    `Request.requestTypeId` does not cascade, so deleting a type with history
    behind it would orphan every request of that type. Those are switched off,
    not erased — which is what the message has to say.
  */
  it('refuses while requests exist and names the count', async () => {
    const { service, deleteType } = serviceWith({ requestCount: 12 });

    await service.deleteType('DSC', principal()).catch((error: AppError) => {
      expect(error.code).toBe('REQ_TYPE_IN_USE');
      expect(error.details?.map((detail) => detail.field)).toContain(
        'requests',
      );
    });

    expect(deleteType).not.toHaveBeenCalled();
    expect.assertions(3);
  });

  it('refuses while an approval matrix still routes the subject', async () => {
    const { service, deleteType } = serviceWith({ matrixCount: 2 });

    await service.deleteType('DSC', principal()).catch((error: AppError) => {
      expect(error.details?.map((detail) => detail.field)).toContain(
        'approval_matrix',
      );
    });

    expect(deleteType).not.toHaveBeenCalled();
    expect.assertions(2);
  });

  it('answers NOT_FOUND for a code that is not there', async () => {
    const { service, deleteType } = serviceWith({ type: null });

    await service.deleteType('NOPE', principal()).catch((error: AppError) => {
      expect(error.code).toBe('NOT_FOUND');
    });

    expect(deleteType).not.toHaveBeenCalled();
    expect.assertions(2);
  });
});
