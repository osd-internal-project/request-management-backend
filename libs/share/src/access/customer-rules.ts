/**
 * Who may see which customers — the one place that decides it (CM-08).
 *
 * The same SCOPE-02/03 contract as `access-rules.ts`: every customer list,
 * single read, and the 360° summary counts build their `where` here, and every
 * clause pins `companyId`. Pure by design, so the rules are testable without a
 * database.
 *
 * Visibility follows the spec's ผังทีม rule: a person sees the customers they
 * are account owner of and their team's; a head sees their groups' — resolved
 * through the same led/scoped unit lists the request rules use. Whole-company
 * reading is the `crm.customer.read.all` permission, mirroring
 * `request.read.all`.
 */
import type { Permission } from '../policy/permissions';
import { reachableUnitIds, type AccessWhere } from './access-rules';

/** Everything customer visibility depends on. */
export interface CustomerAccessSubject {
  readonly userId: string;
  readonly activeCompanyId: string;
  readonly ledUnitIds: readonly string[];
  readonly scopedUnitIds: readonly string[];
  /** `crm.customer.read.all` — every customer in the active company. */
  readonly readsAllCustomers: boolean;
}

/**
 * The facts above, read off a principal. One conversion in one place, matching
 * `accessSubject` for requests, so no caller assembles it by hand.
 *
 * Takes the minimal principal shape rather than the full `Principal` so specs
 * can hand it a stub without casting.
 */
export function customerAccessSubject(principal: {
  readonly userId: string;
  readonly activeCompanyId: string;
  readonly ledUnitIds: readonly string[];
  readonly scopedUnitIds: readonly string[];
  readonly permissions: readonly Permission[];
}): CustomerAccessSubject {
  return {
    userId: principal.userId,
    activeCompanyId: principal.activeCompanyId,
    ledUnitIds: principal.ledUnitIds,
    scopedUnitIds: principal.scopedUnitIds,
    readsAllCustomers: principal.permissions.includes('crm.customer.read.all'),
  };
}

/**
 * The rows of `customers` this caller may see.
 *
 * Three ways in, as `OR` branches:
 *   - being the account owner,
 *   - having created the row — a draft someone registered for another owner
 *     must not vanish from its author before it is even finished,
 *   - the customer's book sitting in a group the caller leads or was granted
 *     (`ownerOrgUnitId`, the snapshot column — an org edit later must not
 *     silently re-scope the register).
 *
 * SCOPE-03: `companyId` is pinned in every branch; a customer outside the
 * caller's reach answers 404 at the endpoint, never 403.
 */
export function visibleCustomersWhere(
  subject: CustomerAccessSubject,
): AccessWhere {
  const company = { companyId: subject.activeCompanyId };

  if (subject.readsAllCustomers) return company;

  const branches: AccessWhere[] = [
    { accountOwnerUserId: subject.userId },
    { createdBy: subject.userId },
  ];

  const units = reachableUnitIds(subject);
  if (units.length) {
    branches.push({ ownerOrgUnitId: { in: units } });
  }

  return { ...company, OR: branches };
}
