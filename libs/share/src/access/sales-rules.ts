/**
 * Who may see which leads and deals — one place, shared by both (they carry
 * the same ownership columns). Mirrors `customer-rules.ts`: owner, author, or
 * a book sitting in a unit the caller leads/was granted; whole-company reading
 * is `crm.sales.read.all`. SCOPE-02/03 contract as everywhere else.
 */
import type { Permission } from '../policy/permissions';
import { reachableUnitIds, type AccessWhere } from './access-rules';

export interface SalesAccessSubject {
  readonly userId: string;
  readonly activeCompanyId: string;
  readonly ledUnitIds: readonly string[];
  readonly scopedUnitIds: readonly string[];
  readonly readsAllSales: boolean;
}

export function salesAccessSubject(principal: {
  readonly userId: string;
  readonly activeCompanyId: string;
  readonly ledUnitIds: readonly string[];
  readonly scopedUnitIds: readonly string[];
  readonly permissions: readonly Permission[];
}): SalesAccessSubject {
  return {
    userId: principal.userId,
    activeCompanyId: principal.activeCompanyId,
    ledUnitIds: principal.ledUnitIds,
    scopedUnitIds: principal.scopedUnitIds,
    readsAllSales: principal.permissions.includes('crm.sales.read.all'),
  };
}

/** The rows of `leads`/`deals` this caller may see. */
export function visibleSalesWhere(subject: SalesAccessSubject): AccessWhere {
  const company = { companyId: subject.activeCompanyId };

  if (subject.readsAllSales) return company;

  const branches: AccessWhere[] = [
    { ownerUserId: subject.userId },
    { createdBy: subject.userId },
  ];

  const units = reachableUnitIds(subject);
  if (units.length) {
    branches.push({ ownerOrgUnitId: { in: units } });
  }

  return { ...company, OR: branches };
}
