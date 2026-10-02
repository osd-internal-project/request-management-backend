import { defectMove, defectProblems, proves } from './defect-rules';

describe('CD-213 defect rules', () => {
  it('a test item proves its own SOW line, or any criterion of the deliverable', () => {
    expect(proves('scope:0', 'scope:0')).toBe(true);
    expect(proves('scope:10', 'scope:1')).toBe(false);
    expect(proves('deliverable:1:0', 'deliverable:1')).toBe(true);
    expect(proves('deliverable:1', 'deliverable:1')).toBe(true);
    expect(proves('deliverable:12:0', 'deliverable:1')).toBe(false);
    expect(proves('change:c1', 'change:c1')).toBe(true);
    expect(proves(null, 'scope:0')).toBe(false);
  });

  it('a defect names what broke, how bad, the SOW line and when found', () => {
    const ok = {
      title: 'บันทึกซ้ำได้',
      severity: 'major',
      sowRef: 'scope:0',
      knownRefs: ['scope:0'],
      foundOn: '2026-10-02',
      today: '2026-10-02',
    };
    expect(defectProblems(ok)).toEqual([]);
    expect(
      defectProblems({
        ...ok,
        title: ' ',
        severity: 'huge',
        sowRef: 'scope:9',
        foundOn: '2026-10-03',
      }),
    ).toHaveLength(4);
    expect(defectProblems({ ...ok, sowRef: '' })).toEqual([
      'ต้องผูกกับข้อ SOW',
    ]);
  });

  it('fixed, then closed only by a retest; a failed retest reopens it; cancel is the manager’s', () => {
    expect(
      defectMove({
        action: 'fix',
        status: 'open',
        note: 'แก้ query',
        canEdit: false,
      }),
    ).toEqual({ problems: [], to: 'fixed' });
    expect(
      defectMove({
        action: 'verify',
        status: 'open',
        note: 'ผ่าน',
        canEdit: true,
      }).problems,
    ).toEqual(['ทำไม่ได้ในสถานะปัจจุบันของข้อบกพร่องนี้']);
    expect(
      defectMove({ action: 'verify', status: 'fixed', note: '', canEdit: true })
        .problems,
    ).toEqual(['ต้องบันทึกผลการทดสอบซ้ำ']);
    expect(
      defectMove({
        action: 'reopen',
        status: 'fixed',
        note: 'ยังซ้ำ',
        canEdit: false,
      }).to,
    ).toBe('open');
    expect(
      defectMove({
        action: 'cancel',
        status: 'open',
        note: 'ซ้ำกับ BUG-1',
        canEdit: false,
      }).problems,
    ).toEqual(['ยกเลิกได้เฉพาะผู้จัดการโครงการ']);
    expect(
      defectMove({ action: 'x', status: 'open', note: 'a', canEdit: true }).to,
    ).toBeNull();
  });
});
