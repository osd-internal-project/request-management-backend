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

  if (subject.ledUnitIds.length) {
    involved.push(
      { requesterOrgUnitId: { in: [...subject.ledUnitIds] } },
      { receiverOrgUnitId: { in: [...subject.ledUnitIds] } },
    );
  }

  return { ...company, OR: involved };
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
          steps: { some: { candidateUserIds: { has: subject.userId } } },
        },
      },
    },
  ];
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
          some: {
            status: 'pending',
            candidateUserIds: { has: subject.userId },
          },
        },
      },
    },
  };
}

/**
 * The rows of `requests` a **group head** may see — the "งานทั้งหมด" screen.
 *
 * Narrower than {@link visibleRequestsWhere} on purpose: that answers "may I
 * open this", while this answers "what is happening under me". Somebody's own
 * request raised outside the groups they lead is not their team's work, and
 * putting it on this screen would make the count mean nothing.
 *
 * Someone who leads nothing gets a clause that matches no rows rather than one
 * that matches everything — the failure mode of an empty `IN ()` written the
 * other way round is a screen that shows the whole company.
 */
export function ledRequestsWhere(subject: AccessSubject): AccessWhere {
  const company = { companyId: subject.activeCompanyId };

  if (!subject.ledUnitIds.length) return { ...company, id: { in: [] } };

  const units = { in: [...subject.ledUnitIds] };

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
