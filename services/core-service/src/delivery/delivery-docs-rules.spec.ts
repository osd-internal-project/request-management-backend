import {
  cleanDocumentsSetting,
  documentsByType,
  nextPhase,
  packStatus,
  requiredFor,
} from './delivery-docs-rules';

describe('CD-251 delivery document rules', () => {
  it('ประเภทงานที่บริษัทไม่ได้ตั้งใช้ค่าตั้งต้น', () => {
    const byType = documentsByType({ equipment: ['ใบส่งของ', 'Spec sheet'] });
    expect(byType.equipment).toEqual(['ใบส่งของ', 'Spec sheet']);
    expect(byType.material).toEqual(['ใบส่งของ']);
    expect(documentsByType(null).service).toEqual(['รายงานการให้บริการ']);
  });

  it('เอกสารบังคับของเฟส = รวมของทุกประเภทงานในรอบส่ง ชื่อซ้ำนับครั้งเดียว', () => {
    const byType = documentsByType({});
    expect(requiredFor(byType, ['material', 'equipment'])).toEqual([
      'ใบส่งของ',
      'ใบรับประกันอุปกรณ์',
      'คู่มือการใช้งานอุปกรณ์',
    ]);
    expect(requiredFor(byType, [])).toEqual([]);
  });

  it('ชุดเอกสาร: ชื่อตรง (ไม่สนตัวพิมพ์/ช่องว่าง) นับเป็นบังคับ ที่เหลือเป็นเพิ่มเติม', () => {
    const pack = packStatus(
      ['ใบส่งของ', 'คู่มือ'],
      [
        { id: 'a', title: ' ใบส่งของ ' },
        { id: 'b', title: 'รูปหน้างาน' },
      ],
    );
    expect(pack.missing).toEqual(['คู่มือ']);
    expect(pack.complete).toBe(false);
    expect(pack.extras.map((d) => d.id)).toEqual(['b']);
    expect(pack.required[0].documents.map((d) => d.id)).toEqual(['a']);
  });

  it('ตรวจค่าตั้ง: ประเภทไม่รู้จัก / ซ้ำ / ช่องว่าง', () => {
    expect(
      cleanDocumentsSetting({
        equipment: [' ใบส่งของ', 'ใบส่งของ', ' '],
        robots: ['x'],
      }),
    ).toEqual({
      value: { equipment: ['ใบส่งของ'] },
      problems: ['ประเภทงาน robots ไม่รู้จัก'],
    });
  });

  it('เฟสถัดไป = หมุดหมายแรกที่ยังไม่บรรลุและมีรอบส่ง', () => {
    const milestones = [
      { id: 'm1', seq: 1, status: 'achieved' },
      { id: 'm3', seq: 3, status: 'planned' },
      { id: 'm2', seq: 2, status: 'planned' },
      { id: 'm4', seq: 4, status: 'planned' },
    ];
    expect(nextPhase(milestones, ['m1', 'm3', 'm4'])?.id).toBe('m3');
    expect(nextPhase(milestones, [])).toBeNull();
  });
});
