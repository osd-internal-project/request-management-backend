import { techPackageGaps } from './tech-package-rules';

const complete = {
  asBuilt: { complete: true, missingDocuments: [], openDeviations: [] },
  configItems: 3,
  integrations: [{ label: 'I-1', name: 'SSO', hasContact: true }],
  cautions: 'อย่ารีสตาร์ท NVR ช่วงสำรองข้อมูล 02:00',
};

describe('CD-227 the technical package to service', () => {
  it('complete: nothing missing', () => {
    expect(techPackageGaps(complete)).toEqual([]);
  });

  it('every gap named, in one pass', () => {
    expect(
      techPackageGaps({
        asBuilt: {
          complete: false,
          missingDocuments: ['แบบติดตั้งจริง'],
          openDeviations: ['D-2'],
        },
        configItems: 0,
        integrations: [
          { label: 'I-1', name: 'SSO', hasContact: true },
          { label: 'I-2', name: 'ERP', hasContact: false },
        ],
        cautions: '  ',
      }),
    ).toEqual([
      'ยังไม่มีเอกสารสภาพจริง: แบบติดตั้งจริง',
      'จุดที่ต่างจากที่ขายยังไม่ปิด: D-2',
      'ยังไม่ได้บันทึกค่าตั้งค่าระบบ',
      'จุดเชื่อมต่อ I-2 ERP ยังไม่มีผู้ติดต่อฝั่งลูกค้า',
      'ยังไม่ได้เขียนข้อควรระวังถึงทีมบริการ',
    ]);
  });

  it('a project without integrations is not asked for any', () => {
    expect(techPackageGaps({ ...complete, integrations: [] })).toEqual([]);
  });
});
