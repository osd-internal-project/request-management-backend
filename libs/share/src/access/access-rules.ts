/**
 * Who may see which rows — the one place that decides it.
 *
 * This replaces the configurable scope levels of §6.1 (`own` / `team` /
 * `department` / `company` / `all`), withdrawn on 31 Aug 2026. Visibility is no
 * longer a property of a role: it follows from **being involved in a request**
 * and from **leading the group the work sits in**, neither of which a
 * `(role, resource) → level` rule can express.
 *
 * SCOPE-01 is gone with the levels. **SCOPE-02 and SCOPE-03 are not.**
 *
 *   - SCOPE-02 said row visibility is decided in exactly one filter layer, so
 *     that a summary count and the rows behind it cannot disagree. That layer
 *     is now this file, and every list, single read and dashboard count still
 *     has to come through it.
 *   - SCOPE-03 said the company boundary is absolute. Every clause below pins
 *     `companyId`, with no level that opts out — the old `all` level, the only
 *     one that crossed companies, no longer exists.
 *
 * Pure by design: it is handed facts and returns a `where` fragment, so the
 * rules can be tested without a database and cannot quietly acquire a query.
 */

/** A Prisma `where` fragment. Shape is per-model, so this stays open. */
export type AccessWhere = Record<string, unknown>;

/** Everything about the caller that visibility depends on. */
export interface AccessSubject {
  readonly userId: string;
  readonly activeCompanyId: string;
  /**
   * Every group this person leads, plus every group beneath those — read from
   * `OrgClosure` when the principal is built, so a list query never walks the
   * chart.
   *
   * Empty for somebody who leads nothing, which is most people.
   */
  readonly ledUnitIds: readonly string[];
  /**
   * Groups reachable through an `OrgUnitScope` grant — "กลุ่มนี้เห็นงานของกลุ่ม
   * นั้น", set on the admin screen.
   *
   * Separate from {@link AccessSubject.ledUnitIds} rather than merged upstream
   * because only one of them widens what a person may *do*: leading a group
   * carries authority over its work, while a scope grant carries it only when
   * an administrator ticked `canAct`.
   */
  readonly scopedUnitIds: readonly string[];
  /** The subset of {@link AccessSubject.scopedUnitIds} granted `canAct`. */
  readonly scopedActUnitIds: readonly string[];
  /**
   * The people this caller is currently covering for (APV-03).
   *
   * A delegation is looked up at decision time rather than at submit, so it
   * cannot be baked into the principal — the caller resolves it and passes it
   * in. Empty for the overwhelming majority of requests.
   *
   * Here because the อนุมัติ tab and the approvals inbox have to agree with the
   * check that runs when the button is actually pressed. They did not: the tab
   * asked only for `candidateUserIds has me`, so somebody covering for an
   * approver saw `0` on a queue they could act on.
   */
  readonly coveringUserIds: readonly string[];
  /**
   * `request.read.all` — the caller reads every request in the active company.
   *
   * What scope `company` used to grant, now an ordinary permission so it is
   * visible in the role editor beside everything else a role can do.
   */
  readonly readsWholeCompany: boolean;
}

/**
 * The rows of `requests` this caller may see.
 *
 * Involvement is deliberately generous about *which* involvement: the person
 * who raised it, the person it was handed to, whoever is carrying it, and
 * anyone named as a possible approver. A request a person is expected to act on
 * that they cannot find is worse than one they can read and will not act on.
 *
 * Leading a group is the other way in, and it reaches the whole subtree — a
 * head of division sees their departments' work without being named on it.
 */
export function visibleRequestsWhere(subject: AccessSubject): AccessWhere {
  const company = { companyId: subject.activeCompanyId };

  if (subject.readsWholeCompany) return company;

  const involved = involvementBranches(subject);
  const units = reachableUnitIds(subject);

  if (units.length) {
    involved.push(
      { requesterOrgUnitId: { in: units } },
      { receiverOrgUnitId: { in: units } },
    );
  }

  return { ...company, OR: involved };
}

/**
 * Every group whose work this person may read: the ones they lead, and the
 * ones granted to their group on the admin screen.
 *
 * De-duplicated because the two overlap constantly — a head of แผนก whose ฝ่าย
 * was granted a view of another ฝ่าย reaches many of the same units twice, and
 * a duplicated id in an `IN (…)` is a wider query for no extra rows.
 */
export function reachableUnitIds(
  subject: Pick<AccessSubject, 'ledUnitIds' | 'scopedUnitIds'>,
): string[] {
  /*
    `?? []` because core-service builds its principal from user-service's JSON,
    and during a rolling deploy the older service answers without these fields.
    Spreading `undefined` into an array throws, which would take every list on
    the site down for the length of the rollout; treating it as "no grants" is
    the same answer the system gave the day before.
  */
  return [
    ...new Set([
      ...(subject.ledUnitIds ?? []),
      ...(subject.scopedUnitIds ?? []),
    ]),
  ];
}

/**
 * The four ways a person is involved in a request, as `OR` branches.
 *
 * Shared by {@link visibleRequestsWhere}, which asks "may I open this", and by
 * the "งานค้างของฉัน" tabs, which ask "is this mine to act on". Written once so
 * the tab counts and the page the tabs open cannot disagree.
 */
export function involvementBranches(subject: AccessSubject): AccessWhere[] {
  return [
    { requesterId: subject.userId },
    { receiverUserId: subject.userId },
    { assigneeUserId: subject.userId },
    {
      approvalCases: {
        some: {
          steps: { some: decidableStepWhere(subject) },
        },
      },
    },
  ];
}

/**
 * The `ApprovalStep` rows this person may decide — the one place that answers
 * it.
 *
 * There used to be three answers. `authorise` accepted `candidateUserIds`, fell
 * back to `approverUserId` for cases opened before that column existed, and
 * honoured a delegation; the approvals inbox asked for `candidateUserIds` plus
 * whoever the caller covers for; the "อนุมัติ" tab asked only for
 * `candidateUserIds has me`. The tab was the narrowest, so it printed `0` for
 * people who could — and did — approve from the other screen.
 *
 * Returned as a fragment rather than a whole `where` so callers can add the
 * `status: 'pending'` they need: the tab wants only steps awaiting a decision,
 * while "may I open this request" counts a step whatever became of it.
 */
export function decidableStepWhere(subject: AccessSubject): AccessWhere {
  const deciders = [subject.userId, ...subject.coveringUserIds];

  return {
    OR: [
      { candidateUserIds: { hasSome: deciders } },
      /*
        Steps routed before `candidateUserIds` existed carry the named approver
        and nothing else. Guarded by `isEmpty` rather than left as a plain `OR`
        branch, so a step that *does* list candidates is decided by that list
        alone — `approverUserId` is only its first entry, and matching it
        separately would let somebody removed from the list keep the step.
      */
      {
        candidateUserIds: { isEmpty: true },
        approverUserId: { in: deciders },
      },
    ],
  };
}

/**
 * The rows of `requests` this person is personally involved in.
 *
 * Deliberately **narrower** than {@link visibleRequestsWhere}: that one also
 * covers the groups they lead, which is what makes a head able to open their
 * team's work. "งานค้างของฉัน" is not that question — a head's own queue should
 * not swell with every ticket in their department, or the tab stops meaning
 * anything and the counts stop being actionable.
 */
export function involvedRequestsWhere(subject: AccessSubject): AccessWhere {
  return {
    companyId: subject.activeCompanyId,
    OR: involvementBranches(subject),
  };
}

/** Requests waiting on this person's decision right now — the อนุมัติ tab. */
export function awaitingDecisionWhere(subject: AccessSubject): AccessWhere {
  return {
    companyId: subject.activeCompanyId,
    approvalCases: {
      some: {
        status: 'pending',
        steps: {
          some: { status: 'pending', ...decidableStepWhere(subject) },
        },
      },
    },
  };
}

/**
 * The rows of `requests` on the "งานทั้งหมด" screen — the work of every group
 * this person can reach, whether by leading it or by a scope grant.
 *
 * Narrower than {@link visibleRequestsWhere} on purpose: that answers "may I
 * open this", while this answers "what is happening in my groups". Somebody's
 * own request raised outside those groups is not their team's work, and
 * putting it on this screen would make the count mean nothing.
 *
 * Scope grants belong here as well as in the visibility rule: work a person
 * can reach only through a grant has no other screen that lists it, and rows
 * that exist but appear nowhere are rows nobody acts on.
 *
 * Someone who reaches no groups gets a clause that matches no rows rather than
 * one that matches everything — the failure mode of an empty `IN ()` written
 * the other way round is a screen that shows the whole company.
 */
export function ledRequestsWhere(subject: AccessSubject): AccessWhere {
  const company = { companyId: subject.activeCompanyId };
  const reachable = reachableUnitIds(subject);

  if (!reachable.length) return { ...company, id: { in: [] } };

  const units = { in: reachable };

  return {
    ...company,
    OR: [{ requesterOrgUnitId: units }, { receiverOrgUnitId: units }],
  };
}

/**
 * The rows of `users` this caller may see.
 *
 * The whole company's directory, because that is what the screens need: a
 * requester picks a receiver "from all users", and an admin placing somebody in
 * the chart picks a head from anywhere in the company. Narrowing it by team was
 * what the `user` scope level did, and it made both of those impossible.
 *
 * Membership, not `primaryCompanyId`: somebody can work in a company that is
 * not their primary one, and they belong in its directory (AUTH-05).
 */
export function visibleUsersWhere(subject: AccessSubject): AccessWhere {
  return { companies: { some: { companyId: subject.activeCompanyId } } };
}
