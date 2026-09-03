import {
  AccessSubject,
  awaitingDecisionWhere,
  decidableStepWhere,
  reachableUnitIds,
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
    scopedUnitIds: [],
    scopedActUnitIds: [],
    coveringUserIds: [],
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
          some: { steps: { some: decidableStepWhere(subject()) } },
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
        some: { steps: { some: decidableStepWhere(subject()) } },
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
            some: { status: 'pending', ...decidableStepWhere(subject()) },
          },
        },
      },
    });
  });

  /**
   * A level naming several people has to reach all of their inboxes, so the
   * list is what is matched.
   *
   * `approverUserId` is read too, but only where the list is empty — the
   * steps routed before the column existed. Guarding it that way is what
   * stops somebody *removed* from a candidate list keeping the step by
   * virtue of having been its first name.
   */
  it('matches the whole candidate list, and the named approver only without one', () => {
    const [byList, byName] = branches(decidableStepWhere(subject()));

    expect(byList).toEqual({ candidateUserIds: { hasSome: [ME] } });
    expect(byName).toEqual({
      candidateUserIds: { isEmpty: true },
      approverUserId: { in: [ME] },
    });
  });
});

/**
 * APV-03. The tab, the approvals inbox and the check that runs when the button
 * is pressed have to agree, and they did not: the tab asked only for
 * `candidateUserIds has me`, so somebody covering for an approver was shown a
 * count of `0` on a queue they were working from the other screen.
 */
describe('a delegate is counted wherever the named approver is', () => {
  const BOSS = 'user-boss';
  const covering = subject({ coveringUserIds: [BOSS] });

  it('reaches steps naming the person being covered for', () => {
    const [byList, byName] = branches(decidableStepWhere(covering));

    expect(byList).toEqual({ candidateUserIds: { hasSome: [ME, BOSS] } });
    expect(byName).toEqual({
      candidateUserIds: { isEmpty: true },
      approverUserId: { in: [ME, BOSS] },
    });
  });

  it('puts the delegate on the อนุมัติ tab, not only in the inbox', () => {
    const where = awaitingDecisionWhere(covering);

    expect(JSON.stringify(where)).toContain(BOSS);
  });

  it('lets the delegate open the request they are being asked to decide', () => {
    expect(JSON.stringify(visibleRequestsWhere(covering))).toContain(BOSS);
  });
});

/**
 * The replacement for the withdrawn `(role, resource) → level` rules: an
 * administrator picks a level (บริษัท / ฝ่าย / แผนก / ตำแหน่ง), picks a group at
 * it, and names the groups whose work that group may see.
 */
describe('visibility follows a scope grant between groups', () => {
  const granted = ['unit-marketing', 'unit-marketing-digital'];
  const viewer = subject({ scopedUnitIds: granted });

  it('adds the granted groups to what a person can open', () => {
    const where = visibleRequestsWhere(viewer);

    expect(branches(where)).toContainEqual({
      requesterOrgUnitId: { in: granted },
    });
    expect(branches(where)).toContainEqual({
      receiverOrgUnitId: { in: granted },
    });
  });

  /*
    Work reachable only through a grant has no other screen that lists it.
    Rows that exist but appear nowhere are rows nobody acts on, which is the
    same as not having granted anything.
  */
  it('puts the granted work on the งานทั้งหมด screen', () => {
    expect(ledRequestsWhere(viewer)).toEqual({
      companyId: OSD,
      OR: [
        { requesterOrgUnitId: { in: granted } },
        { receiverOrgUnitId: { in: granted } },
      ],
    });
  });

  it('de-duplicates a group that is both led and granted', () => {
    const overlap = subject({
      ledUnitIds: ['unit-a', 'unit-b'],
      scopedUnitIds: ['unit-b', 'unit-c'],
    });

    expect(reachableUnitIds(overlap)).toEqual(['unit-a', 'unit-b', 'unit-c']);
  });

  it('reaches nothing for somebody with neither', () => {
    expect(reachableUnitIds(subject())).toEqual([]);
    expect(ledRequestsWhere(subject())).toEqual({
      companyId: OSD,
      id: { in: [] },
    });
  });

  /*
    SCOPE-03. A grant is written between two groups of one company and the
    company is pinned regardless — there is no level left that crosses one.
  */
  it('still pins the company', () => {
    expect(visibleRequestsWhere(viewer).companyId).toBe(OSD);
  });

  /**
   * The read list and the act list are separate on purpose, and nothing in
   * this file may quietly merge them: `assertMayAct` in core-service reads
   * `scopedActUnitIds`, and a grant defaults to read-only.
   */
  it('does not let a read-only grant widen what may be acted on', () => {
    const readOnly = subject({ scopedUnitIds: granted, scopedActUnitIds: [] });

    expect(reachableUnitIds(readOnly)).toEqual(granted);
    expect(readOnly.scopedActUnitIds).toEqual([]);
  });
});
