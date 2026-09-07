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
   * Groups reached by the visibility level on this person's roles — the
   * subtree of their own nearest ancestor at that level.
   *
   * A third way in beside leading a group and being granted one, and the only
   * one that follows a person when they move: `Role.visibilityLevel` names a
   * level of the chart, not a unit, so the same role reaches RND for somebody
   * in RND and Sale for somebody in Sale.
   *
   * Read-only, deliberately. It is unioned into
   * {@link reachableUnitIds} and reaches nothing that decides whether a request
   * may be moved — the authority lists are `ledUnitIds` and `scopedAct*`.
   */
  readonly levelUnitIds: readonly string[];
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
   * Individual people reachable through a grant written to a person rather
   * than to a group — "ให้คนนี้เห็นงานของคนนั้น" (4 ก.ย. 2569).
   *
   * Kept apart from {@link AccessSubject.scopedUnitIds} because it matches
   * different columns: a person is `requesterId`/`receiverUserId`/
   * `assigneeUserId`, never an org unit id. Folding the two together upstream
   * would compare a user id against `requesterOrgUnitId` and silently match
   * nothing.
   */
  readonly scopedUserIds: readonly string[];
  /** The subset of {@link AccessSubject.scopedUserIds} granted `canAct`. */
  readonly scopedActUserIds: readonly string[];
  /**
   * Groups and people whose approvals this caller may decide through a scope
   * grant carrying `approval.decide` (7 ก.ย. 2569).
   *
   * Here, and not only in `ApprovalsService.authorise`, because an approver who
   * cannot *find* the work cannot approve it: the อนุมัติ tab and its badge are
   * built from these rules, and a decision the handler would accept while the
   * queue shows nothing is the same defect as no permission at all.
   */
  readonly scopedDecideUnitIds: readonly string[];
  readonly scopedDecideUserIds: readonly string[];
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
 *
 * **This is also the list behind "งานทั้งหมด" (4 ก.ย. 2569).** That screen used
 * to call a narrower `ledRequestsWhere`, which asked "what is happening in my
 * groups" and so dropped the caller's own requests when they were raised
 * outside those groups. The argument for keeping the two apart was that a
 * head's team view should not be diluted by their personal work; in practice
 * the screen it produced was empty for everybody who leads nothing — most
 * people — with no way to tell that from a failed load. "งานทั้งหมด" now means
 * what it says: everything this person may open. The per-queue questions are
 * the tabs on the landing page, which narrow this.
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

  /*
    Only when the list has entries. `{ in: [] }` inside an `OR` is a branch
    that can never be true — harmless but pointless — and adding it
    unconditionally would make every `where` this file produces harder to read
    in a query log, which is where visibility bugs get diagnosed.
  */
  const people = subject.scopedUserIds ?? [];

  if (people.length) {
    involved.push(
      { requesterId: { in: people } },
      { receiverUserId: { in: people } },
      { assigneeUserId: { in: people } },
    );
  }

  return { ...company, OR: involved };
}

/**
 * Every group whose work this person may read: the ones they lead, the ones
 * their role's visibility level reaches down their own branch, and the ones
 * granted to their group on the admin screen.
 *
 * De-duplicated because the three overlap constantly — a head of แผนก whose
 * ฝ่าย was granted a view of another ฝ่าย reaches many of the same units twice,
 * and a duplicated id in an `IN (…)` is a wider query for no extra rows.
 */
export function reachableUnitIds(subject: AccessSubject): string[] {
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
      ...(subject.levelUnitIds ?? []),
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
    approvalRouteBranch(subject),
  ];
}

/**
 * Requests naming this caller anywhere in their approval route — the "อนุมัติ"
 * tab.
 *
 * **Whatever became of the case.** The tab used to ask
 * {@link awaitingDecisionWhere}, which is a queue: a case that is `pending`
 * with a step that is `pending`. That made the tab a filter on the *status of
 * the work* rather than on what the caller may reach, so a request they
 * decided last week — or one still climbing towards them — was simply absent,
 * and the tab printed `0` for people with a full approval history.
 *
 * The queue question has not gone away; {@link awaitingDecisionWhere} still
 * answers it, and the screen prints that count as a badge beside this one.
 */
export function inApprovalRouteWhere(subject: AccessSubject): AccessWhere {
  const granted = scopedDecideBranch(subject);

  if (!granted) {
    return {
      companyId: subject.activeCompanyId,
      ...approvalRouteBranch(subject),
    };
  }

  return {
    companyId: subject.activeCompanyId,
    OR: [
      approvalRouteBranch(subject),
      { AND: [granted, { approvalCases: { some: {} } }] },
    ],
  };
}

/**
 * The involvement branch that says "my name is on this ladder".
 *
 * Written once because {@link involvementBranches} and
 * {@link inApprovalRouteWhere} must agree: a request the อนุมัติ tab counts
 * that the visibility rule will not open is a row on a screen nobody can read.
 */
function approvalRouteBranch(subject: AccessSubject): AccessWhere {
  return {
    approvalCases: {
      some: {
        steps: { some: decidableStepWhere(subject) },
      },
    },
  };
}

/**
 * The requests a scope grant lets this caller decide approvals on.
 *
 * Matched on the request's own columns rather than on the step, because that is
 * where a grant reaches: a grant names a group or a person, and a step names
 * neither. Returns `null` when no grant carries `approval.decide`, so callers
 * can leave the branch out rather than add one that can never be true.
 */
function scopedDecideBranch(subject: AccessSubject): AccessWhere | null {
  const units = subject.scopedDecideUnitIds ?? [];
  const people = subject.scopedDecideUserIds ?? [];

  if (!units.length && !people.length) return null;

  const reaches: AccessWhere[] = [];

  if (units.length) {
    reaches.push(
      { requesterOrgUnitId: { in: [...units] } },
      { receiverOrgUnitId: { in: [...units] } },
    );
  }

  if (people.length) {
    reaches.push(
      { requesterId: { in: [...people] } },
      { receiverUserId: { in: [...people] } },
      { assigneeUserId: { in: [...people] } },
    );
  }

  return { OR: reaches };
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
  const named = {
    approvalCases: {
      some: {
        status: 'pending',
        steps: {
          some: { status: 'pending', ...decidableStepWhere(subject) },
        },
      },
    },
  };

  const granted = scopedDecideBranch(subject);

  if (!granted) return { companyId: subject.activeCompanyId, ...named };

  /*
    A grant reaches whatever step is pending, not a step that names the holder
    — nothing named them. So the case has to be pending and have a pending step,
    and the *request* has to be one the grant reaches.
  */
  return {
    companyId: subject.activeCompanyId,
    OR: [
      named,
      {
        AND: [
          granted,
          {
            approvalCases: {
              some: {
                status: 'pending',
                steps: { some: { status: 'pending' } },
              },
            },
          },
        ],
      },
    ],
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
