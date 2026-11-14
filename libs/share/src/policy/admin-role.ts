import {
  ALL_PERMISSIONS,
  Permission,
  permissionLevel,
  permissionType,
} from './permissions';

/** รหัส role ผู้ดูแลของทุกบริษัท (ROLE-04 — role ผูกบริษัทเสมอ). */
export const COMPANY_ADMIN_ROLE_CODE = 'admin';

/**
 * ทุกสิทธิ์อ่านของคนที่ `admin` ไม่ได้รับ แม้ชื่อจะลงท้าย `.read`.
 *
 * `request.sensitive.read` ถูก §5.4 ห้ามถือคู่กับ `admin.*` — ใส่เข้าไปจะโดน
 * `assertSeparationOfDuties` ตีกลับ 422 อีกสองตัวเป็นการถอดหน้ากากข้อมูล ซึ่ง
 * CM-08/C360-02 ออกแบบให้ตั้งรายบทบาท ไม่ใช่ของแถมของผู้ดูแลระบบ.
 */
const ADMIN_READ_EXCLUSIONS: readonly Permission[] = [
  'request.sensitive.read',
  'crm.customer.sensitive.read',
  'crm.customer.financial.read',
];

/**
 * สิทธิ์ของ `admin` — ทุกสิทธิ์ตั้งค่า บวกทุกสิทธิ์อ่านของคน.
 *
 * คำนวณจาก catalog แทนที่จะพิมพ์เป็นรายการ เพราะรายการเดิมตกหล่น
 * `admin.integration.manage` เงียบ ๆ ตั้งแต่ 14 ก.ย. 2569 และจะตกหล่นซ้ำทุกครั้งที่
 * เพิ่มหน้า admin ใหม่. ใช้ทั้ง seed และการสร้างบริษัทจากหน้าระบบ (14 พ.ย. 2569).
 *
 * `permissionType` กัน `integration.*` ออก: นั่นคือสิทธิ์ของบัญชีบริการ (AUTH-06).
 * `approval.decide` ไม่เข้าเงื่อนไขเพราะไม่ใช่สิทธิ์อ่าน ตรงกับ §5.2.
 */
export function adminPermissions(): Permission[] {
  return ALL_PERMISSIONS.filter(
    (code) =>
      permissionType(code) === 'human' &&
      permissionLevel(code) === 'COMPANY' &&
      !ADMIN_READ_EXCLUSIONS.includes(code) &&
      (code.startsWith('admin.') ||
        code.endsWith('.read') ||
        code.endsWith('.read.all')),
  );
}

/** ชุดสิทธิ์ของ role `admin` ตามที่ seed ตั้ง — ผู้ตั้งค่า softphone ได้ใช้พื้นที่โทรด้วย */
export function companyAdminRolePermissions(): Permission[] {
  return [...adminPermissions(), 'phone.workspace.use'];
}
