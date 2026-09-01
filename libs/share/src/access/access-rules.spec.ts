import {
  AccessSubject,
  awaitingDecisionWhere,
  involvedRequestsWhere,
  ledRequestsWhere,
  visibleRequestsWhere,
  visibleUsersWhere,
} from './access-rules';

const OSD = 'company-osd';
const ME = 'user-me';

function subject(overrides: Partial<AccessSubject> = {}): AccessSubject {
  return {
    userId: ME,
    activeCompanyId: OSD,
    ledUnitIds: [],
    readsWholeCompany: false,
    ...overrides,
  };
}

/** The `OR` branches, for tests that care about one of them. */
function branches(where: Record<string, unknown>): Record<string, unknown>[] {
  return (where.OR ?? []) as Record<string, unknown>[];
}

describe('SCOPE-03: the company boundary is absolute', () => {
  it('pins the active company for an ordinary caller', () => {
    expect(visibleRequestsWhere(subject()).companyId).toBe(OSD);
  });

  /**
   * The withdrawn `all` level was the one that crossed companies. Nothing
   * replaced it: reading the whole company is still one company.
   */
  it('pins it for a caller who reads the whole company too', () => {
    const where = visibleRequestsWhere(subject({ readsWholeCompany: true }));

    expect(where).toEqual({ companyId: OSD });
  });

  it('pins it on the group-head screen', () => {
    expect(ledRequestsWhere(subject({ ledUnitIds: ['u'] })).companyId).toBe(
      OSD,
    );
  });

  it('pins it on the user directory', () => {
    expect(visibleUsersWhere(subject())).toEqual({
      companies: { some: { companyId: OSD } },
    });
  });
});

describe('visibility follows involvement', () => {
  it('covers every way of being involved in a request', () => {
    expect(branches(visibleRequestsWhere(subject()))).toEqual([
      { requesterId: ME },
      { receiverUserId: ME },
      { assigneeUserId: ME },
      {
        approvalCases: {
          some: { steps: { some: { candidateUserIds: { has: ME } } } },
        },
      },
    ]);
  });

  /**
   * SCOPE-06 used to be a special case bolted onto the scope levels, because
   * scope `own` could not see a case you were merely named on. It is an
   * ordinary branch now, so there is nothing left to bolt on — and it matches
   * the whole candidate list, because a level can name several people.
   */
  it('lets a named approver see the request without any extra rule', () => {
    const where = visibleRequestsWhere(subject());

    expect(branches(where)).toContainEqual({
      approvalCases: {
        some: { steps: { some: { candidateUserIds: { has: ME } } } },
      },
    });
  });

  it('drops the OR entirely for a caller who reads the whole company', () => {
    expect(visibleRequestsWhere(subject({ readsWholeCompany: true })).OR).toBe(
      undefined,
    );
  });
});

describe('visibility follows leading a group', () => {
  const led = ['unit-dept', 'unit-position'];

  it('adds the led groups to what a person can open', () => {
    const where = visibleRequestsWhere(subject({ ledUnitIds: led }));

    expect(branches(where)).toContainEqual({
      requesterOrgUnitId: { in: led },
    });
    expect(branches(where)).toContainEqual({
      receiverOrgUnitId: { in: led },
    });
  });

  it('adds nothing for somebody who leads nothing', () => {
    expect(branches(visibleRequestsWhere(subject()))).toHaveLength(4);
  });

  it('narrows the group-head screen to those groups alone', () => {
    expect(ledRequestsWhere(subject({ ledUnitIds: led }))).toEqual({
      companyId: OSD,
      OR: [
        { requesterOrgUnitId: { in: led } },
        { receiverOrgUnitId: { in: led } },
      ],
    });
  });

  /**
   * The dangerous shape: a clause built from an empty set that ends up
   * matching everything. Leading nothing must show nothing, not the company.
   */
  it('matches no rows when the viewer leads nothing', () => {
    expect(ledRequestsWhere(subject())).toEqual({
      companyId: OSD,
      id: { in: [] },
    });
  });
});

describe('the tabs of งานค้างของฉัน narrow, they do not widen', () => {
  const led = ['unit-dept'];

  /**
   * The first tab is not the same question as "what may I open". A head's own
   * queue must not fill with their department's work, or the count on the tab
   * stops meaning anything they can act on.
   */
  it('involved excludes the groups the viewer leads', () => {
    const where = involvedRequestsWhere(subject({ ledUnitIds: led }));

    expect(branches(where)).toHaveLength(4);
    expect(branches(where)).not.toContainEqual({
      requesterOrgUnitId: { in: led },
    });
  });

  it('involved and visible agree on what involvement means', () => {
    const plain = subject();

    expect(branches(involvedRequestsWhere(plain))).toEqual(
      branches(visibleRequestsWhere(plain)),
    );
  });

  /**
   * "Waiting on me" is a step that is pending, on a case that is pending —
   * not every case my name appears on further down a ladder.
   */
  it('the approver tab asks for a step that is actually pending', () => {
    expect(awaitingDecisionWhere(subject())).toEqual({
      companyId: OSD,
      approvalCases: {
        some: {
          status: 'pending',
          steps: {
            some: { status: 'pending', candidateUserIds: { has: ME } },
          },
        },
      },
    });
  });

  /** A level naming several people has to reach all of their inboxes. */
  it('matches on the candidate list, not just the first name', () => {
    const clause = JSON.stringify(involvedRequestsWhere(subject()));

    expect(clause).toContain('candidateUserIds');
    expect(clause).not.toContain('approverUserId');
  });
});
