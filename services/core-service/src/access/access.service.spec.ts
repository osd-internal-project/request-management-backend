import { AccessService } from './access.service';

const REQUESTER = 'u_requester';

/**
 * A four-level chart, nearest first as `ancestorIdsOf` returns it:
 * the requester's position, its department, its division, the company.
 */
const ANCESTORS = ['unit-position', 'unit-dept', 'unit-division', 'unit-root'];

function serviceWith(heads: Record<string, string | undefined>) {
  const orgUnits = {
    ancestorIdsOf: jest.fn(() => Promise.resolve(ANCESTORS)),
    managersOf: jest.fn((ids: readonly string[]) =>
      Promise.resolve(
        ids.map((id) => heads[id]).filter((id): id is string => Boolean(id)),
      ),
    ),
  };

  return { service: new AccessService(orgUnits as never), orgUnits };
}

describe('APV-02: a supervisor level counts levels of the chart', () => {
  const heads = {
    'unit-position': 'u_lead',
    'unit-dept': 'u_manager',
    'unit-division': 'u_director',
    'unit-root': 'u_ceo',
  };

  it.each([
    [1, 'u_lead'],
    [2, 'u_manager'],
    [3, 'u_director'],
    [4, 'u_ceo'],
  ])('up: %i resolves to %s', async (up, expected) => {
    const { service } = serviceWith(heads);

    await expect(
      service.approverCandidatesOf(
        { type: 'supervisor', up },
        { requesterId: REQUESTER, orgUnitId: 'unit-position' },
      ),
    ).resolves.toEqual([expected]);
  });

  /**
   * The real chart has groups nobody has been put in charge of yet. Stopping
   * there would mean a whole department could not submit anything until an
   * admin noticed, so the search climbs on.
   */
  it('climbs past a group with no head', async () => {
    const { service } = serviceWith({
      'unit-dept': undefined,
      'unit-division': 'u_director',
    });

    await expect(
      service.approverCandidatesOf(
        { type: 'supervisor', up: 2 },
        { requesterId: REQUESTER, orgUnitId: 'unit-position' },
      ),
    ).resolves.toEqual(['u_director']);
  });

  it('finds nobody once the chart runs out', async () => {
    const { service } = serviceWith({});

    await expect(
      service.approverCandidatesOf(
        { type: 'supervisor', up: 1 },
        { requesterId: REQUESTER, orgUnitId: 'unit-position' },
      ),
    ).resolves.toEqual([]);
  });

  it('finds nobody for a requester who sits nowhere', async () => {
    const { service, orgUnits } = serviceWith(heads);

    await expect(
      service.approverCandidatesOf(
        { type: 'supervisor', up: 1 },
        { requesterId: REQUESTER, orgUnitId: null },
      ),
    ).resolves.toEqual([]);

    expect(orgUnits.ancestorIdsOf).not.toHaveBeenCalled();
  });
});

describe('APV-02: an org level names groups, or people inside them', () => {
  it('resolves to the heads of the groups named', async () => {
    const { service } = serviceWith({
      'unit-fin': 'u_cfo',
      'unit-exec': 'u_ceo',
    });

    await expect(
      service.approverCandidatesOf(
        { type: 'org', orgUnitIds: ['unit-fin', 'unit-exec'] },
        { requesterId: REQUESTER, orgUnitId: 'unit-position' },
      ),
    ).resolves.toEqual(['u_cfo', 'u_ceo']);
  });

  it('resolves to the named people when there are any', async () => {
    const { service, orgUnits } = serviceWith({ 'unit-fin': 'u_cfo' });

    await expect(
      service.approverCandidatesOf(
        { type: 'org', orgUnitIds: ['unit-fin'], userIds: ['u_a', 'u_b'] },
        { requesterId: REQUESTER, orgUnitId: 'unit-position' },
      ),
    ).resolves.toEqual(['u_a', 'u_b']);

    // Naming people is the whole answer; the group is only where they came
    // from on screen.
    expect(orgUnits.managersOf).not.toHaveBeenCalled();
  });
});

describe('APV-02: nobody approves their own request', () => {
  it('drops the requester from a level that names them', async () => {
    const { service } = serviceWith({});

    await expect(
      service.approverCandidatesOf(
        { type: 'org', orgUnitIds: ['unit-fin'], userIds: [REQUESTER, 'u_b'] },
        { requesterId: REQUESTER, orgUnitId: 'unit-position' },
      ),
    ).resolves.toEqual(['u_b']);
  });

  /**
   * A manager raising a request would otherwise be handed their own approval.
   * The level resolves to nobody, and `planChain` skips it rather than
   * stalling the case.
   */
  it('leaves a level empty when the requester is its only approver', async () => {
    const { service } = serviceWith({ 'unit-position': REQUESTER });

    await expect(
      service.approverCandidatesOf(
        { type: 'supervisor', up: 1 },
        { requesterId: REQUESTER, orgUnitId: 'unit-position' },
      ),
    ).resolves.toEqual([]);
  });

  it('de-duplicates a person named twice', async () => {
    const { service } = serviceWith({});

    await expect(
      service.approverCandidatesOf(
        { type: 'org', orgUnitIds: ['a'], userIds: ['u_a', 'u_a', 'u_b'] },
        { requesterId: REQUESTER, orgUnitId: null },
      ),
    ).resolves.toEqual(['u_a', 'u_b']);
  });
});
