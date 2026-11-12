/**
 * Row visibility for any module whose rows have an owner, in one place (P3).
 * The request rules (`visibleRequestsWhere`) stay their own: a request has a
 * requester, a receiver and an approval chain, which no owner column says.
 *
 * Ways in, as `OR` branches, always inside the active company (SCOPE-03):
 *   - a user column naming the caller, or a person granted to them by name
 *     (`OrgUnitScope` with a target user),
 *   - the row's unit inside what the caller leads, reaches through their
 *     role's visibility level, or was granted — read from a snapshot column
 *     when the module has one, otherwise from the owner's current unit (Q10).
 */
import { reachableUnitIds, type AccessWhere } from './access-rules';

export interface OwnedSubject {
  readonly userId: string;
  readonly activeCompanyId: string;
  readonly ledUnitIds: readonly string[];
  readonly scopedUnitIds: readonly string[];
  /** Optional so a principal from an older user-service still fits. */
  readonly levelUnitIds?: readonly string[];
  readonly scopedUserIds?: readonly string[];
}

export interface OwnedColumns {
  /** Columns holding a user id: owner, assignee, creator… */
  readonly users: readonly string[];
  /** A snapshot unit column on the row, e.g. `ownerOrgUnitId`. */
  readonly unit?: string;
  /** A relation to `User` whose current `orgUnitId` places the row (Q10). */
  readonly ownerRelation?: string;
}

export function ownedBranches(
  subject: OwnedSubject,
  columns: OwnedColumns,
): AccessWhere[] {
  const people = [subject.userId, ...(subject.scopedUserIds ?? [])];
  const person = people.length === 1 ? people[0] : { in: people };

  const branches: AccessWhere[] = columns.users.map((column) => ({
    [column]: person,
  }));

  const units = reachableUnitIds(subject);
  if (units.length) {
    if (columns.unit) branches.push({ [columns.unit]: { in: units } });
    if (columns.ownerRelation) {
      branches.push({ [columns.ownerRelation]: { orgUnitId: { in: units } } });
    }
  }

  return branches;
}

/** `readsAll` is the module's `.read.all` permission: the whole active company. */
export function visibleOwnedWhere(
  subject: OwnedSubject,
  columns: OwnedColumns,
  readsAll: boolean,
): AccessWhere {
  const company = { companyId: subject.activeCompanyId };
  if (readsAll) return company;

  return { ...company, OR: ownedBranches(subject, columns) };
}
