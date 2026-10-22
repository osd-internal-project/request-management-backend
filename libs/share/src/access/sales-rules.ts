/**
 * Who may see which leads and opportunities — one place, shared by both (they carry
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
  /**
   * A machine holding `integration.crm.lead.read` (workflow engine, AI agent)
   * reads every lead of its key's company: it acts for the company, not for a
   * person, so there is no person's scope to borrow (22 ต.ค. 2569). Leads only.
   *
   * Only the machine itself: a person the machine acts for (`X-Acting-User`,
   * MCP) keeps their own rows even when their permissions list the scope.
   */
  readonly readsAllLeads?: boolean;
}

export function salesAccessSubject(principal: {
  readonly userId: string;
  readonly activeCompanyId: string;
  readonly ledUnitIds: readonly string[];
  readonly scopedUnitIds: readonly string[];
  readonly permissions: readonly Permission[];
  readonly isServiceAccount?: boolean;
}): SalesAccessSubject {
  return {
    userId: principal.userId,
    activeCompanyId: principal.activeCompanyId,
    ledUnitIds: principal.ledUnitIds,
    scopedUnitIds: principal.scopedUnitIds,
    readsAllSales: principal.permissions.includes('crm.sales.read.all'),
    readsAllLeads:
      principal.isServiceAccount === true &&
      principal.permissions.includes('integration.crm.lead.read'),
  };
}

/**
 * The rows of `opportunities`/`quotations`/`sale_orders` this caller may see.
 * ห้ามใช้กับ `leads` — ใช้ `visibleLeadsWhere` ที่เติมกิ่งกองกลางให้.
 */
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

/**
 * The rows of `leads` this caller may see — เหมือน `visibleSalesWhere` บวกกองกลาง
 * (`ownerUserId IS NULL`) ที่ทุกคนซึ่งอ่าน Lead ได้ในบริษัทนี้เห็น: ใบกองกลางมีไว้
 * ให้ถูกหยิบ ไม่ใช่ให้รอหัวหน้ามาเปิด. กิ่งนี้อยู่ที่นี่ที่เดียวเพราะ
 * `Opportunity`/`Quotation`/`SaleOrder.ownerUserId` เป็น NOT NULL — Prisma reject
 * ทั้ง query ถ้าส่ง null ไป.
 */
export function visibleLeadsWhere(subject: SalesAccessSubject): AccessWhere {
  if (subject.readsAllLeads) return { companyId: subject.activeCompanyId };
  const where = visibleSalesWhere(subject);
  const branches = where.OR as AccessWhere[] | undefined;

  if (!branches) return where; // crm.sales.read.all — ทั้งบริษัทอยู่แล้ว

  return { ...where, OR: [...branches, { ownerUserId: null }] };
}
