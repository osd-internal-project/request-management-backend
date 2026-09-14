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

/** The rows of `leads`/`opportunities` this caller may see. */
export function visibleSalesWhere(subject: SalesAccessSubject): AccessWhere {
  const company = { companyId: subject.activeCompanyId };

  if (subject.readsAllSales) return company;

  const branches: AccessWhere[] = [
    { ownerUserId: subject.userId },
    { createdBy: subject.userId },
    /*
      กองกลาง — ใบที่ยังไม่มีเจ้าของ (Lead ที่ระบบภายนอกยิงเข้ามา, 14 ก.ย. 2569)
      ทุกคนที่อ่าน Lead ได้ในบริษัทนี้เห็น.

      เจตนา ไม่ใช่ผลข้างเคียง: ใบกองกลางมีอยู่เพื่อให้ถูกหยิบ ถ้าเห็นเฉพาะคนที่
      ถือ `crm.sales.read.all` มันจะกลายเป็นกล่องที่ต้องรอหัวหน้ามาเปิด — ซึ่ง
      คือการทำให้ลูกค้าที่กรอกฟอร์มตอนสองทุ่มรอถึงเช้าวันจันทร์.

      แคบอยู่แล้วโดยบรรทัดบน: `company` ผูกทุกกิ่งไว้กับบริษัทที่ active (SCOPE-03)
      และ `ownerUserId IS NULL` เป็นจริงได้เฉพาะก่อน assign — พอ `assign` เขียน
      เจ้าของลงไป ใบนั้นก็ออกจากกองกลางทันทีโดยไม่ต้องมีสถานะแยก.

      สำหรับ `opportunities` กิ่งนี้ไม่เคยเป็นจริง (คอลัมน์ยัง NOT NULL) — ตั้งใจ
      ให้เป็นอย่างนั้น: โอกาสการขายไม่มีกองกลาง มันเกิดจากคนที่แปลง Lead เสมอ.
    */
    { ownerUserId: null },
  ];

  const units = reachableUnitIds(subject);
  if (units.length) {
    branches.push({ ownerOrgUnitId: { in: units } });
  }

  return { ...company, OR: branches };
}
