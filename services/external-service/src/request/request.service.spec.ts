import { AppError } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { RequestApiService } from './request.service';

const OSD = 'company-osd';

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    userId: 'user-somchai',
    username: 'somchai',
    activeCompanyId: OSD,
    orgUnitId: 'ou-sales',
    permissions: ['request.create', 'request.read'],
    isServiceAccount: false,
    pendingOrgAssignment: false,
    ...overrides,
    // Only the fields these paths read. Double cast because a partial principal
    // no longer overlaps the full one enough for a single one.
  } as unknown as Principal;
}

function build() {
  const requests = {
    list: jest.fn(),
    scopedWhere: jest.fn((_actor: unknown, query: unknown) => ({
      marker: query,
    })),
    findOne: jest.fn(),
    // Requests without a step flow report no moves.
    flowMovesOf: jest.fn().mockResolvedValue(null),
  };
  const approvals = { coveringFor: jest.fn().mockResolvedValue([]) };
  const requestRows = {
    countByStatus: jest.fn(),
    countWhere: jest.fn(),
    findIdByNumber: jest.fn(),
  };
  const orgUnits = { descendantIdsOf: jest.fn() };
  const members = { findInUnits: jest.fn() };
  const directory = {
    searchUsers: jest.fn<
      Promise<unknown>,
      [unknown, { orgUnitIds?: readonly string[]; q?: string }]
    >(),
  };

  return {
    requests,
    approvals,
    requestRows,
    orgUnits,
    directory,
    service: new RequestApiService(
      requests as never,
      approvals as never,
      requestRows as never,
      orgUnits as never,
      members as never,
      directory as never,
    ),
  };
}

describe('G-02 — the summary counts what the list would show (SCOPE-02)', () => {
  it('builds its filter with the same function the list builds its page with', async () => {
    const { requests, requestRows, service } = build();

    requestRows.countByStatus.mockResolvedValue({});
    requestRows.countWhere.mockResolvedValue(0);

    await service.summary(principal(), { view: 'created', type_code: 'PS01' });

    expect(requests.scopedWhere).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ view: 'created', type_code: 'PS01' }),
      [],
    );
  });

  it('defaults to the same view the list defaults to', async () => {
    const { requests, requestRows, service } = build();

    requestRows.countByStatus.mockResolvedValue({});
    requestRows.countWhere.mockResolvedValue(0);

    await service.summary(principal(), {});

    expect(requests.scopedWhere.mock.calls[0][1]).toMatchObject({
      view: 'involved',
    });
  });

  /*
    The reason `open_total` exists at all. "งานค้างกี่ใบ" is not "how many rows
    are there" — a closed request is still counted in the breakdown, because a
    caller asking for one wants the whole picture, but rolling it into the
    outstanding figure would overstate somebody's workload every time.
  */
  it('excludes terminal statuses from the outstanding figure', async () => {
    const { requestRows, service } = build();

    requestRows.countByStatus.mockResolvedValue({
      submitted: 2,
      in_progress: 3,
      pending_approval: 2,
      closed: 12,
      cancelled: 5,
      rejected: 1,
    });
    requestRows.countWhere.mockResolvedValue(1);

    const summary = await service.summary(principal(), {});

    expect(summary.open_total).toBe(7);
    expect(summary.total).toBe(25);
    expect(summary.overdue).toBe(1);
    expect(summary.counts.closed).toBe(12);
  });

  it('counts overdue with the overdue filter switched on, not from the breakdown', async () => {
    const { requests, requestRows, service } = build();

    requestRows.countByStatus.mockResolvedValue({});
    requestRows.countWhere.mockResolvedValue(4);

    await service.summary(principal(), { view: 'involved' });

    expect(requests.scopedWhere).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ overdue: true }),
      [],
    );
  });
});

describe('G-09 — create_child is a fact, not an action', () => {
  const REF = 'f7f7609e-9317-454e-875d-ec543bc4caf0';

  const requestAt = (status: string) => ({
    id: 'req-1',
    requestNo: 'REQ-OSD-PS01-26090003',
    status,
    requesterId: 'user-somchai',
    receiverUserId: null,
    assigneeUserId: null,
    requesterOrgUnitId: 'ou-sales',
    receiverOrgUnitId: null,
    approvalCases: [],
  });

  it('never offers it as something to send', async () => {
    const { requests, service } = build();

    requests.findOne.mockResolvedValue(requestAt('in_progress'));

    const answer = await service.actionsFor(REF, principal());

    expect(answer.actions.map((a) => a.action)).not.toContain('create_child');
  });

  it('reports it separately so a caller still knows a child is allowed', async () => {
    const { requests, service } = build();

    requests.findOne.mockResolvedValue(requestAt('in_progress'));

    expect((await service.actionsFor(REF, principal())).can_create_child).toBe(
      true,
    );
  });

  it('says no once the request is finished', async () => {
    const { requests, service } = build();

    requests.findOne.mockResolvedValue(requestAt('closed'));

    expect((await service.actionsFor(REF, principal())).can_create_child).toBe(
      false,
    );
  });

  it('strips it from every row of a list too', async () => {
    const { requests, service } = build();

    requests.list.mockResolvedValue({
      data: [{ id: 'r1', available_actions: ['comment', 'create_child'] }],
      total: 1,
      page: 1,
      page_size: 20,
    });

    const page = (await service.list(principal(), {} as never)) as {
      data: { available_actions: string[] }[];
    };

    expect(page.data[0].available_actions).toEqual(['comment']);
  });
});

describe('G-03 — looking somebody up', () => {
  it('asks the shared directory, so the answer matches GET /users', async () => {
    const { directory, service } = build();

    directory.searchUsers.mockResolvedValue({ data: [], total: 0 });

    await service.searchUsers(principal(), { q: 'ชนะกุล' } as never);

    expect(directory.searchUsers).toHaveBeenCalledWith(
      expect.objectContaining({ activeCompanyId: OSD }),
      expect.objectContaining({ q: 'ชนะกุล' }),
    );
  });

  it('resolves the caller own subtree for scope=team', async () => {
    const { orgUnits, directory, service } = build();

    orgUnits.descendantIdsOf.mockResolvedValue(['ou-sales', 'ou-getter']);
    directory.searchUsers.mockResolvedValue({ data: [], total: 0 });

    await service.searchUsers(principal(), { scope: 'team' } as never);

    expect(orgUnits.descendantIdsOf).toHaveBeenCalledWith('ou-sales');
    expect(directory.searchUsers.mock.calls[0][1].orgUnitIds).toEqual([
      'ou-sales',
      'ou-getter',
    ]);
  });

  /*
    Somebody in the รอจัดสังกัด queue asking for "my team" has no team. The
    empty list has to reach the directory, where it means "nobody" — dropping
    it would answer the narrowest possible question with the whole company.
  */
  it('asks for nobody, not everybody, when the caller has no group', async () => {
    const { orgUnits, directory, service } = build();

    directory.searchUsers.mockResolvedValue({ data: [], total: 0 });

    await service.searchUsers(
      principal({ orgUnitId: null, pendingOrgAssignment: true }),
      { scope: 'team' } as never,
    );

    expect(orgUnits.descendantIdsOf).not.toHaveBeenCalled();
    expect(directory.searchUsers.mock.calls[0][1].orgUnitIds).toEqual([]);
  });

  it('does not narrow by group at all for the default company scope', async () => {
    const { directory, service } = build();

    directory.searchUsers.mockResolvedValue({ data: [], total: 0 });

    await service.searchUsers(principal(), {} as never);

    expect(directory.searchUsers.mock.calls[0][1].orgUnitIds).toBeUndefined();
  });
});

/**
 * The dispatcher's own gate. Every other route on this port states its acting
 * permission in a decorator and `ActingPolicyGuard` enforces it; this one
 * route performs fourteen verbs with a different permission each, so the
 * check moved inside. These tests are why it is not merely documentation.
 */
describe('the action dispatcher checks the acting user per verb', () => {
  it('refuses a verb the person lacks the permission for', async () => {
    const { requests, requestRows, service } = build();

    // `hold` needs `request.hold`; this person holds only create and read.
    const refused = await service
      .perform(
        'REQ-OSD-PS01-26090001',
        'hold',
        { reason: 'รอของ' },
        principal(),
        'Bearer token',
      )
      .catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(AppError);
    const error = refused as AppError;

    expect(error.code).toBe('FORBIDDEN');
    /*
      Names the missing permission, so an integrator holding a perfectly good
      key reads which grant the *person* lacks rather than assuming the key is
      wrong and rotating it.
    */
    expect(error.details).toContainEqual({
      field: 'permission',
      reason: 'request.hold',
    });

    // Refused before the reference is even resolved, so a caller without the
    // permission cannot use the endpoint to find out what exists.
    expect(requestRows.findIdByNumber).not.toHaveBeenCalled();
    expect(requests.findOne).not.toHaveBeenCalled();
  });

  it('admits the same verb once the person holds it', async () => {
    const { service, requests } = build();
    const hold = jest.fn<Promise<{ id: string }>, []>();
    hold.mockResolvedValue({ id: 'req-1' });
    (requests as unknown as { hold: typeof hold }).hold = hold;

    await service.perform(
      '11111111-2222-3333-4444-555555555555',
      'hold',
      { reason: 'รอของ' },
      principal({ permissions: ['request.hold'] }),
      'Bearer token',
    );

    expect(hold).toHaveBeenCalled();
  });

  it('still rejects an unknown verb as a validation error, not a 403', async () => {
    const { service } = build();

    await expect(
      service.perform('ref', 'teleport', {}, principal(), 'Bearer token'),
    ).rejects.toEqual(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });
});

describe('step flow — advance through the external API', () => {
  const REF = '11111111-2222-3333-4444-555555555555';

  it('hands to_step to the same service method the screen calls', async () => {
    const { service, requests } = build();
    const advance = jest.fn<Promise<{ id: string }>, unknown[]>();
    advance.mockResolvedValue({ id: 'req-1' });
    (requests as unknown as { advance: typeof advance }).advance = advance;

    await service.perform(
      REF,
      'advance',
      { to_step: 'INSTALL' },
      principal({ permissions: ['request.complete'] }),
      'Bearer token',
    );

    expect(advance).toHaveBeenCalledWith(
      REF,
      { to_step: 'INSTALL' },
      expect.anything(),
      'Bearer token',
    );
  });

  it('refuses advance without to_step', async () => {
    const { service } = build();

    await expect(
      service.perform(
        REF,
        'advance',
        {},
        principal({ permissions: ['request.complete'] }),
        'Bearer token',
      ),
    ).rejects.toEqual(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });

  it('refuses a person without request.complete', async () => {
    const { service } = build();

    await expect(
      service.perform(
        REF,
        'advance',
        { to_step: 'INSTALL' },
        principal(),
        'Bearer token',
      ),
    ).rejects.toEqual(expect.objectContaining({ code: 'FORBIDDEN' }));
  });
});
