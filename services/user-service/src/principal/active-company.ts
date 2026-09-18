import { PrincipalCompany } from '@request-management/share';

/**
 * บริษัทที่ request หนึ่งทำงานอยู่ (AUTH-05).
 *
 * แยกออกมาเป็นฟังก์ชันบริสุทธิ์เพราะเป็นกฎที่ทุก request ต้องผ่านและมีหลายชั้น —
 * เขียนไว้ในที่เดียวที่ unit test อ่านได้ ดีกว่ากระจายเป็น if ใน service
 *
 * ลำดับ header > lastCompanyId > primaryCompanyId > isPrimary > ตัวแรก:
 * header คือเจตนาของ request ตรงหน้าจึงชนะเสมอ ถัดมาคือบริษัทที่เจ้าตัวเลือกไว้ล่าสุด
 * ซึ่งเป็นคำตอบที่ถูกสำหรับคนที่ทำงานอยู่บริษัทอื่นที่ไม่ใช่สังกัดหลัก แล้วจึงค่อยตกไป
 * ที่สังกัดที่ผู้ดูแลกำหนด
 *
 * ทุกชั้นถูกกรองด้วยสมาชิกภาพปัจจุบันเสมอ ค่าที่ค้างอยู่จากสมาชิกภาพที่ถูกถอนไปแล้ว
 * จึงตกไปชั้นถัดไปเอง โดยไม่ต้องมีงานล้างข้อมูลแยก
 *
 * @returns null เมื่อยังไม่มีสมาชิกภาพบริษัทใดเลย — ผู้ใช้ที่รอจัดสังกัด (AUTH-04)
 */
export function pickActiveCompany(
  companies: readonly PrincipalCompany[],
  requested: string | undefined,
  lastCompanyId: string | null,
  primaryCompanyId: string | null,
): string | null {
  const isMember = (companyId: string) =>
    companies.some((company) => company.id === companyId);

  if (requested && isMember(requested)) {
    return requested;
  }

  if (lastCompanyId && isMember(lastCompanyId)) {
    return lastCompanyId;
  }

  if (primaryCompanyId && isMember(primaryCompanyId)) {
    return primaryCompanyId;
  }

  return (
    companies.find((company) => company.isPrimary)?.id ??
    companies[0]?.id ??
    null
  );
}
