import { findingProblems, moveProblems, uatState } from './uat-rules';

const today = '2026-10-08';
const move = {
  action: 'fix',
  status: 'open',
  severity: 'major',
  note: 'แก้สิทธิ์ผู้ใช้แล้ว',
  confirmedBy: '',
  confirmedOn: null,
  today,
  canEdit: false,
};

describe('CD-222 UAT rules', () => {
  it('a finding says what, how serious, and when the customer raised it', () => {
    expect(
      findingProblems({
        title: 'พิมพ์รายงานไม่ได้',
        severity: 'blocker',
        reportedOn: today,
        today,
      }),
    ).toEqual([]);
    expect(
      findingProblems({
        title: ' ',
        severity: 'x',
        reportedOn: '2026-10-09',
        today,
      }),
    ).toHaveLength(3);
  });

  it('fixed says how; confirmed says who at the customer, and when', () => {
    expect(moveProblems(move)).toEqual({ problems: [], to: 'fixed' });
    expect(moveProblems({ ...move, note: '' }).problems).toEqual([
      'ต้องบอกว่าแก้อย่างไร',
    ]);
    expect(
      moveProblems({
        ...move,
        action: 'confirm',
        status: 'fixed',
        confirmedBy: 'คุณสมชาย',
        confirmedOn: today,
      }),
    ).toEqual({ problems: [], to: 'confirmed' });
    expect(
      moveProblems({ ...move, action: 'confirm', status: 'open' }).problems,
    ).toHaveLength(3);
  });

  it('a fix the customer turns down reopens it, with why', () => {
    expect(
      moveProblems({
        ...move,
        action: 'reopen',
        status: 'fixed',
        note: 'ยังช้า',
      }),
    ).toEqual({ problems: [], to: 'open' });
  });

  it('only the manager defers, never a blocker, always with a reason', () => {
    expect(
      moveProblems({
        ...move,
        action: 'defer',
        canEdit: true,
        note: 'ทำในเฟส 2',
      }),
    ).toEqual({ problems: [], to: 'deferred' });
    expect(
      moveProblems({
        ...move,
        action: 'defer',
        severity: 'blocker',
        note: '',
        canEdit: false,
      }).problems,
    ).toEqual([
      'ประเด็นที่ปิดกั้นการใช้งานต้องแก้ก่อนตรวจรับ เลื่อนไม่ได้',
      'ต้องระบุเหตุผลที่เลื่อน',
      'เลื่อนหรือนำกลับได้เฉพาะผู้จัดการโครงการ',
    ]);
  });

  it('a blocker blocks until the customer confirms the fix', () => {
    expect(
      uatState([
        { label: 'U-1', severity: 'blocker', status: 'fixed' },
        { label: 'U-2', severity: 'blocker', status: 'confirmed' },
        { label: 'U-3', severity: 'minor', status: 'deferred' },
        { label: 'U-4', severity: 'major', status: 'open' },
      ]),
    ).toEqual({
      total: 4,
      open: 1,
      fixed: 1,
      confirmed: 1,
      deferred: 1,
      blocking: ['U-1'],
    });
  });
});
