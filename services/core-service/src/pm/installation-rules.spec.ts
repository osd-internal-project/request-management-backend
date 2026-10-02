import {
  boqChoices,
  boqMatch,
  pointProblems,
  unexplainedMismatches,
} from './installation-rules';

const baseline = {
  boq: [
    { kind: 'equipment', name: 'กล้อง IP', quantity: 2, unit: 'ตัว' },
    { kind: 'material', name: 'สาย LAN', quantity: 300, unit: 'ม.' },
    { kind: 'equipment', name: 'เครื่องบันทึก', quantity: 1 },
  ],
};
const ok = {
  location: 'อาคาร A ชั้น 2',
  boqIndex: 0,
  boqCount: 3,
  equipment: true,
  serialNo: 'SN-1',
  installedOn: '2026-10-08',
  hasAfter: true,
  today: '2026-10-08',
};

describe('CD-216 installation rules', () => {
  it('a point may install any BOQ line; equipment is the one counted', () => {
    expect(boqChoices(baseline).map((row) => row.equipment)).toEqual([
      true,
      false,
      true,
    ]);
  });

  it('installed means a photo after, and the serial for equipment', () => {
    expect(pointProblems(ok)).toEqual([]);
    expect(pointProblems({ ...ok, serialNo: ' ', hasAfter: false })).toEqual([
      'ติดตั้งแล้วต้องแนบรูปหลังติดตั้ง',
      'อุปกรณ์ที่ติดตั้งแล้วต้องมีหมายเลขเครื่อง',
    ]);
    // planned, not yet installed: neither is needed yet
    expect(
      pointProblems({
        ...ok,
        installedOn: null,
        serialNo: null,
        hasAfter: false,
      }),
    ).toEqual([]);
    expect(
      pointProblems({
        ...ok,
        location: ' ',
        boqIndex: 9,
        installedOn: '2026-10-09',
      }),
    ).toHaveLength(3);
  });

  it('installed units of each equipment line against the BOQ', () => {
    const lines = boqMatch(baseline, [
      { boqIndex: 0, installedOn: '2026-10-08' },
      { boqIndex: 0, installedOn: null },
      { boqIndex: 2, installedOn: '2026-10-08' },
      { boqIndex: 1, installedOn: '2026-10-08' },
    ]);
    expect(
      lines.map((line) => [line.ref, line.installed, line.matches]),
    ).toEqual([
      ['boq:0', 1, false],
      ['boq:2', 1, true],
    ]);
    expect(unexplainedMismatches(lines, [])).toEqual([
      'BOQ 1: กล้อง IP: ติดตั้ง 1 จาก 2 — ต้องบันทึกจุดที่ต่างอ้างบรรทัดนี้',
    ]);
    expect(unexplainedMismatches(lines, ['boq:0', null])).toEqual([]);
  });

  it('no BOQ, nothing to match', () => {
    expect(boqMatch(null, [])).toEqual([]);
  });
});
