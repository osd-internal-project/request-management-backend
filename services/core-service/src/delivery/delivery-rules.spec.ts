import {
  boqCoverage,
  deliveryProblems,
  deliveryReadiness,
  needsWarning,
} from './delivery-rules';

const boq = [
  { index: 0, label: 'BOQ 1: Switch', quantity: 10, unit: 'ตัว' },
  { index: 1, label: 'BOQ 2: สาย', quantity: 100, unit: 'ม.' },
];
const line = {
  boqIndex: 0,
  quantity: 4,
  readiness: 'ready',
  readyQty: null,
  expectedOn: null,
  fallbackPlan: '',
};

describe('CD-250 delivery rules', () => {
  it('รอบส่งที่ถูกต้องไม่มีปัญหา', () => {
    expect(
      deliveryProblems({
        plannedOn: '2026-10-20',
        location: 'ไซต์ A',
        lines: [line],
        boq,
      }),
    ).toEqual([]);
  });

  it('ของไม่พร้อมต้องมีแผนสำรอง; บางส่วนต้องบอกจำนวนที่พร้อม', () => {
    expect(
      deliveryProblems({
        plannedOn: '2026-10-20',
        location: 'ไซต์ A',
        lines: [
          { ...line, readiness: 'not_ready' },
          { ...line, boqIndex: 1, readiness: 'partial', readyQty: 4 },
        ],
        boq,
      }),
    ).toEqual([
      'BOQ 1: Switch: ของยังไม่พร้อมต้องมีแผนสำรอง',
      'BOQ 2: สาย: พร้อมบางส่วนต้องระบุจำนวนที่พร้อม (น้อยกว่าที่ส่ง)',
      'BOQ 2: สาย: ของยังไม่พร้อมต้องมีแผนสำรอง',
    ]);
  });

  it('บรรทัดนอก BOQ / ซ้ำ / ไม่มีสถานที่', () => {
    expect(
      deliveryProblems({
        plannedOn: '2026-10-20',
        location: ' ',
        lines: [line, line, { ...line, boqIndex: 5 }],
        boq,
      }),
    ).toEqual([
      'ต้องระบุสถานที่ส่ง',
      'BOQ 1: Switch: ซ้ำในรอบเดียวกัน',
      'BOQ 6: ไม่อยู่ในฐานตั้งต้นของโครงการ',
    ]);
  });

  it('รวมทุกรอบเทียบ BOQ: เกิน / ยังไม่อยู่ในแผน', () => {
    const rows = boqCoverage(boq, [
      { boqIndex: 0, quantity: 6 },
      { boqIndex: 0, quantity: 6 },
    ]);
    expect(rows.map((r) => [r.planned, r.remaining, r.over])).toEqual([
      [12, -2, true],
      [0, 100, false],
    ]);
  });

  it('เตือนเมื่อใกล้วันส่งและยังมีบรรทัดไม่พร้อม', () => {
    const delivery = {
      plannedOn: '2026-10-10',
      status: 'planned',
      lines: [{ readiness: 'ready' }, { readiness: 'unknown' }],
    };
    expect(needsWarning(delivery, '2026-10-05', 7)).toBe(true);
    expect(needsWarning(delivery, '2026-10-01', 7)).toBe(false);
    expect(needsWarning(delivery, '2026-10-11', 7)).toBe(false);
    expect(
      needsWarning(
        { ...delivery, lines: [{ readiness: 'ready' }] },
        '2026-10-05',
        7,
      ),
    ).toBe(false);
    expect(deliveryReadiness(delivery.lines)).toBe('unknown');
    expect(
      deliveryReadiness([{ readiness: 'partial' }, { readiness: 'not_ready' }]),
    ).toBe('not_ready');
  });
});
