import { PrincipalCompany } from '@request-management/share';
import { pickActiveCompany } from './active-company';

const company = (id: string, isPrimary = false): PrincipalCompany => ({
  id,
  name: id.toUpperCase(),
  docPrefix: id.slice(0, 3).toUpperCase(),
  isPrimary,
});

const OSD = company('osd', true);
const BCO = company('bco');
const CTD = company('ctd');
const MEMBERSHIPS = [OSD, BCO, CTD];

describe('AUTH-05 pickActiveCompany', () => {
  it('ยึด header ก่อนทุกอย่าง เพราะเป็นเจตนาของ request ตรงหน้า', () => {
    expect(pickActiveCompany(MEMBERSHIPS, BCO.id, CTD.id, OSD.id)).toBe(BCO.id);
  });

  it('ไม่มี header แล้วใช้บริษัทที่เลือกไว้ล่าสุด ไม่ใช่สังกัดหลัก', () => {
    expect(pickActiveCompany(MEMBERSHIPS, undefined, CTD.id, OSD.id)).toBe(
      CTD.id,
    );
  });

  it('ยังไม่เคยสลับบริษัท จึงตกไปที่สังกัดหลัก', () => {
    expect(pickActiveCompany(MEMBERSHIPS, undefined, null, BCO.id)).toBe(
      BCO.id,
    );
  });

  it('สมาชิกภาพถูกถอนหลังเลือกไว้ ค่าที่ค้างอยู่ต้องตกไปสังกัดหลัก', () => {
    expect(pickActiveCompany([OSD, BCO], undefined, CTD.id, BCO.id)).toBe(
      BCO.id,
    );
  });

  it('header ที่ไม่ได้เป็นสมาชิกไม่ชนะ — CompanyGuard จะปฏิเสธต่ออีกชั้น', () => {
    expect(pickActiveCompany([OSD, BCO], CTD.id, null, OSD.id)).toBe(OSD.id);
  });

  it('ไม่มีทั้งค่าล่าสุดและสังกัดหลัก จึงใช้บริษัทที่ทำเครื่องหมาย isPrimary', () => {
    expect(pickActiveCompany(MEMBERSHIPS, undefined, null, null)).toBe(OSD.id);
  });

  it('ไม่มี isPrimary เลย จึงใช้บริษัทแรกที่เป็นสมาชิก', () => {
    expect(pickActiveCompany([BCO, CTD], undefined, null, null)).toBe(BCO.id);
  });

  it('ยังไม่มีสมาชิกภาพบริษัทใด — AUTH-04 รอจัดสังกัด', () => {
    expect(pickActiveCompany([], undefined, CTD.id, OSD.id)).toBeNull();
  });
});
