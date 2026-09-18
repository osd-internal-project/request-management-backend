import { AppError } from '../errors';
import { isPermission, permissionType } from './permissions';

/**
 * แยกสิทธิ์ของคนกับสิทธิ์ของเครื่องออกจากกัน (AUTH-06).
 *
 * `permissions.type` มีมาตั้งแต่ต้นเพื่อบอกว่าสิทธิ์ตัวไหนเป็นของบัญชีบริการ แต่ไม่เคยมี
 * อะไรบังคับ — role ของคนจึงถือ `integration.*` ได้ และกุญแจ API ก็ถือสิทธิ์ของคนได้
 * ไฟล์นี้ทำให้ `type` เป็นกฎ ไม่ใช่ป้ายกำกับ
 *
 * ถามผ่าน `permissionType` เสมอ ไม่ตรวจ prefix เอง — catalog เป็นคนตอบว่าอะไรเป็นของใคร
 * และคำตอบนั้นต้องมีที่เดียว
 */

function conflicting(
  permissions: readonly string[],
  unwanted: 'human' | 'service',
): string[] {
  // รหัสที่ไม่มีใน catalog ปล่อยผ่าน — `@IsIn(ALL_PERMISSIONS)` ปฏิเสธไปก่อนแล้ว และ
  // การตอบ "ไม่ใช่สิทธิ์ของคน" กับรหัสที่ไม่มีอยู่จริงคือคำตอบที่ทำให้ไล่ปัญหาผิดทาง
  return permissions.filter(
    (permission) =>
      isPermission(permission) && permissionType(permission) === unwanted,
  );
}

/**
 * ชุดสิทธิ์ที่จะให้ role ของคนถือ
 *
 * @throws AppError `UNPROCESSABLE` ระบุสิทธิ์ของเครื่องที่หลุดเข้ามา
 */
export function assertHumanPermissions(permissions: readonly string[]): void {
  const machine = conflicting(permissions, 'service');
  if (!machine.length) return;

  // 422 เหมือน assertSeparationOfDuties: ทุกรหัสในคำขอมีอยู่จริง สิ่งที่ปฏิเสธคือการเอา
  // สิทธิ์ของเครื่องไปให้คน
  throw new AppError(
    'UNPROCESSABLE',
    `role ของผู้ใช้ถือสิทธิ์ของบัญชีบริการไม่ได้: ${machine.join(', ')} — ` +
      'ออกให้กุญแจ API ที่หน้า "กุญแจ API" แทน',
    machine.map((permission) => ({ field: 'permissions', reason: permission })),
  );
}

/**
 * ชุดสิทธิ์ที่จะออกให้กุญแจ API
 *
 * @throws AppError `UNPROCESSABLE` ระบุสิทธิ์ของคนที่หลุดเข้ามา
 */
export function assertServicePermissions(permissions: readonly string[]): void {
  const human = conflicting(permissions, 'human');
  if (!human.length) return;

  throw new AppError(
    'UNPROCESSABLE',
    `กุญแจ API ถือสิทธิ์ของผู้ใช้ไม่ได้: ${human.join(', ')} — ` +
      'สิ่งที่คนทำได้ตัดสินจาก X-Acting-User ไม่ใช่จากกุญแจ',
    human.map((permission) => ({ field: 'scopes', reason: permission })),
  );
}
