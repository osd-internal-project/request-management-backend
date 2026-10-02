import {
  cleanEquipment,
  handoffBlockers,
  weeklyEquipment,
} from './tech-plan-rules';

const boq = [{ name: 'กล้อง IP', unit: 'ตัว' }];

describe('CD-209 technical plan rules', () => {
  it('equipment from a BOQ line takes its name and unit; anything else needs a name', () => {
    expect(
      cleanEquipment(
        [
          { boq_index: 0, quantity: 4 },
          { name: 'บันไดอลูมิเนียม', quantity: 1, unit: 'อัน' },
        ],
        boq,
      ),
    ).toEqual({
      lines: [
        { boqIndex: 0, name: 'กล้อง IP', quantity: 4, unit: 'ตัว', note: null },
        {
          boqIndex: null,
          name: 'บันไดอลูมิเนียม',
          quantity: 1,
          unit: 'อัน',
          note: null,
        },
      ],
      problems: [],
    });
    expect(
      cleanEquipment(
        [
          { boq_index: 5, quantity: 1 },
          { name: '', quantity: 0 },
        ],
        boq,
      ).problems,
    ).toEqual([
      'อุปกรณ์ข้อ 1: บรรทัด BOQ ไม่อยู่ในฐานตั้งต้น',
      'อุปกรณ์ข้อ 2: ต้องระบุชื่ออุปกรณ์หรือเลือกบรรทัด BOQ',
      'อุปกรณ์ข้อ 2: จำนวนต้องมากกว่า 0',
    ]);
  });

  it('handoff 7 waits for an owner on every task, and equipment where needed', () => {
    expect(
      handoffBlockers([
        {
          label: '1.1 เดินสาย',
          ownerUserId: 'u',
          needsEquipment: false,
          equipment: 0,
          status: 'open',
        },
        {
          label: '1.2 ติดกล้อง',
          ownerUserId: null,
          needsEquipment: true,
          equipment: 0,
          status: 'open',
        },
        {
          label: '1.3 ยกเลิก',
          ownerUserId: null,
          needsEquipment: true,
          equipment: 0,
          status: 'cancelled',
        },
      ]),
    ).toEqual([
      'งานที่ยังไม่มีผู้รับผิดชอบ: 1.2 ติดกล้อง',
      'งานที่ต้องใช้อุปกรณ์แต่ยังไม่ระบุ: 1.2 ติดกล้อง',
    ]);
    expect(
      handoffBlockers([
        {
          label: '1',
          ownerUserId: 'u',
          needsEquipment: true,
          equipment: 2,
          status: 'open',
        },
      ]),
    ).toEqual([]);
  });

  it('equipment is summed for every week a task runs', () => {
    expect(
      weeklyEquipment([
        {
          start: '2026-10-08',
          finish: '2026-10-13',
          equipment: [{ name: 'กล้อง IP', quantity: 4, unit: 'ตัว' }],
        },
        {
          start: '2026-10-12',
          finish: '2026-10-12',
          equipment: [{ name: 'กล้อง IP', quantity: 2, unit: 'ตัว' }],
        },
        {
          start: null,
          finish: null,
          equipment: [{ name: 'x', quantity: 1, unit: null }],
        },
      ]),
    ).toEqual([
      {
        week: '2026-10-05',
        items: [{ name: 'กล้อง IP', unit: 'ตัว', quantity: 4 }],
      },
      {
        week: '2026-10-12',
        items: [{ name: 'กล้อง IP', unit: 'ตัว', quantity: 6 }],
      },
    ]);
  });
});
