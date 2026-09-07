import {
  AccessSubject,
  awaitingDecisionWhere,
  decidableStepWhere,
  inApprovalRouteWhere,
  reachableUnitIds,
  involvedRequestsWhere,
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
    levelUnitIds: [],
    scopedUnitIds: [],
    scopedActUnitIds: [],
    scopedUserIds: [],
    scopedActUserIds: [],
    scopedDecideUnitIds: [],
    scopedDecideUserIds: [],
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

  it('pins it on the งานทั้งหมด screen', () => {
    expect(visibleRequestsWhere(subject({ ledUnitIds: ['u'] })).companyId).toBe(
      OSD,
    );
  });

  it('pins it on the อนุมัติ tab', () => {
    expect(inApprovalRouteWhere(subject()).companyId).toBe(OSD);
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

describe('visibility follows the level a role carries', () => {
  const branch = ['unit-rnd', 'unit-dev'];

  it('adds the branch the level reaches to what a person can open', () => {
    const where = visibleRequestsWhere(subject({ levelUnitIds: branch }));

    expect(branches(where)).toContainEqual({
      requesterOrgUnitId: { in: branch },
    });
    expect(branches(where)).toContainEqual({
      receiverOrgUnitId: { in: branch },
    });
  });

  it('unions with the groups led and the groups granted, without duplicates', () => {
    const reached = reachableUnitIds(
      subject({
        ledUnitIds: ['unit-rnd'],
        levelUnitIds: branch,
        scopedUnitIds: ['unit-dev', 'unit-sales'],
      }),
    );

    expect(reached.sort()).toEqual(['unit-dev', 'unit-rnd', 'unit-sales']);
  });

  it('is still pinned to the active company', () => {
    const where = visibleRequestsWhere(subject({ levelUnitIds: branch }));

    expect(where.companyId).toBe(OSD);
  });

  it('adds nothing when the level reached no ancestor', () => {
    expect(
      branches(visibleRequestsWhere(subject({ levelUnitIds: [] }))),
    ).toHaveLength(4);
  });

  /**
   * During a rolling deploy core-service builds its principal from an older
   * user-service's JSON, which answers without this field. Treating it as "no
   * level" is the same answer the system gave the day before; spreading
   * `undefined` would take every list on the site down for the rollout.
   */
  it('survives a principal from a service that predates the field', () => {
    const older = {
      ...subject(),
      levelUnitIds: undefined,
    } as unknown as AccessSubject;

    expect(() => reachableUnitIds(older)).not.toThrow();
    expect(reachableUnitIds(older)).toEqual([]);
  });
});

describe('an approver who reaches the work through a scope grant', () => {
  const RND = 'unit-rnd';

  /**
   * `ApprovalsService.authorise` accepts a grant carrying `approval.decide`.
   * If the queue did not, the holder could decide a case they had no way of
   * opening — the same defect as holding no permission at all, just harder to
   * diagnose.
   */
  it('finds the pending work in the อนุมัติ queue', () => {
    const where = awaitingDecisionWhere(
      subject({ scopedDecideUnitIds: [RND] }),
    );

    expect(where.companyId).toBe(OSD);
    expect(JSON.stringify(where)).toContain(RND);
  });

  it('finds it in the approval-route list too', () => {
    expect(
      JSON.stringify(
        inApprovalRouteWhere(subject({ scopedDecideUnitIds: [RND] })),
      ),
    ).toContain(RND);
  });

  it('reaches it through a grant written to one person', () => {
    expect(
      JSON.stringify(
        awaitingDecisionWhere(subject({ scopedDecideUserIds: ['user-them'] })),
      ),
    ).toContain('user-them');
  });

  /**
   * Without a grant the queue is exactly what it was: a step that names the
   * caller. A branch that can never be true would only make the query log
   * harder to read, which is where visibility bugs get diagnosed.
   */
  it('adds no branch at all for somebody with no such grant', () => {
    const where = awaitingDecisionWhere(subject());

    expect(where.OR).toBeUndefined();
    expect(where.approvalCases).toBeDefined();
  });

  it('is still pinned to the active company', () => {
    expect(
      awaitingDecisionWhere(subject({ scopedDecideUnitIds: [RND] })).companyId,
    ).toBe(OSD);
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

  /**
   * "งานทั้งหมด" is this rule and nothing else since 4 ก.ย. 2569 — it used to
   * call a narrower `ledRequestsWhere` that dropped the caller's own requests
   * when they were raised outside the groups they lead.
   */
  it('keeps the viewer own work on the งานทั้งหมด screen beside their groups', () => {
    const where = visibleRequestsWhere(subject({ ledUnitIds: led }));

    expect(branches(where)).toContainEqual({ requesterId: ME });
    expect(branches(where)).toContainEqual({ requesterOrgUnitId: { in: led } });
  });

  /**
   * The dangerous shape: a clause built from an empty set that ends up
   * matching everything. Someone who leads nothing still sees their own work,
   * and never the company's.
   */
  it('shows only involvement when the viewer leads nothing', () => {
    const where = visibleRequestsWhere(subject());

    expect(branches(where)).toHaveLength(4);
    expect(where.companyId).toBe(OSD);
  });
});

/**
 * REQ-08 — one screen for "my requests" and "awaiting my approval" across all
 * types. Each tab narrows what the caller may already see, and narrows by
 * *access* only: filtering by status is what the filter bar is for, and doing
 * it inside a tab is what made `รับเรื่อง` print `0` beside `สร้าง · 3`.
 */
describe('REQ-08: the tabs of งานค้างของฉัน narrow by access, not by status', () => {
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
   * The tab narrows by access, not by state: everything my name is on, decided
   * or not. Filtering it to pending cases is what made a full approval history
   * read as `อนุมัติ · 0`.
   */
  it('the approver tab does not filter by the state of the case', () => {
    const where = inApprovalRouteWhere(subject());

    expect(where).toEqual({
      companyId: OSD,
      approvalCases: {
        some: { steps: { some: decidableStepWhere(subject()) } },
      },
    });
    expect(JSON.stringify(where)).not.toContain('pending');
  });

  it('the tab and the visibility rule agree on what the route means', () => {
    const plain = subject();
    const { companyId, ...branch } = inApprovalRouteWhere(plain);

    expect(companyId).toBe(OSD);
    expect(branches(visibleRequestsWhere(plain))).toContainEqual(branch);
  });

  /**
   * "Waiting on me" is a step that is pending, on a case that is pending —
   * not every case my name appears on further down a ladder. Still needed:
   * the approvals inbox asks it, and the tab prints it as a badge beside the
   * broader count above.
   */
  it('the queue question survives as its own rule', () => {
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
    expect(branches(visibleRequestsWhere(viewer))).toContainEqual({
      requesterOrgUnitId: { in: granted },
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
    /*
      Asked as "no branch mentions the column" rather than with
      `expect.anything()`, which is typed `any` and fails the lint that keeps
      `any` out of this package.
    */
    expect(
      branches(visibleRequestsWhere(subject())).some(
        (branch) => 'requesterOrgUnitId' in branch,
      ),
    ).toBe(false);
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

/**
 * SCOPE-01's second replacement (4 ก.ย. 2569): a grant may name one person on
 * either end. Naming a group when the real arrangement is "this designer
 * covers this account manager" hands over both groups in full.
 */
describe('visibility follows a scope grant to a person', () => {
  const COVERED = 'user-covered';
  const viewer = subject({ scopedUserIds: [COVERED] });

  it('reaches that person work however they are attached to it', () => {
    const where = branches(visibleRequestsWhere(viewer));

    expect(where).toContainEqual({ requesterId: { in: [COVERED] } });
    expect(where).toContainEqual({ receiverUserId: { in: [COVERED] } });
    expect(where).toContainEqual({ assigneeUserId: { in: [COVERED] } });
  });

  /*
    A user id compared against `requesterOrgUnitId` matches nothing and looks
    like a working filter, which is why the two lists are never merged.
  */
  it('does not match a person against an org unit column', () => {
    const where = branches(visibleRequestsWhere(viewer));

    expect(where).not.toContainEqual({
      requesterOrgUnitId: { in: [COVERED] },
    });
    expect(reachableUnitIds(viewer)).toEqual([]);
  });

  it('adds nothing at all when no grant names a person', () => {
    expect(branches(visibleRequestsWhere(subject()))).toHaveLength(4);
  });

  it('still pins the company', () => {
    expect(visibleRequestsWhere(viewer).companyId).toBe(OSD);
  });

  /**
   * The act list is separate for the same reason the unit lists are: reading
   * somebody work and moving it are different grants, and `hasAuthority` in
   * core-service reads only `scopedActUserIds`.
   */
  it('does not let a read-only grant widen what may be acted on', () => {
    expect(viewer.scopedActUserIds).toEqual([]);
  });

  it('is dropped for a caller who reads the whole company anyway', () => {
    expect(
      visibleRequestsWhere(
        subject({ scopedUserIds: [COVERED], readsWholeCompany: true }),
      ),
    ).toEqual({ companyId: OSD });
  });
});
