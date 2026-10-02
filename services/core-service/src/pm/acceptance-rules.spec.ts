import {
  bookProblems,
  criteriaAccepted,
  followUp,
  resultProblems,
} from './acceptance-rules';

const now = new Date('2026-10-08T03:00:00Z');
const ok = {
  ready: true,
  blockers: [],
  scheduledAt: new Date('2026-10-10T02:00:00Z'),
  now,
  openRound: null,
  milestoneStatus: 'planned',
};

describe('CD-189 acceptance rules', () => {
  it('booked only when ready, in the future, and not twice', () => {
    expect(bookProblems(ok)).toEqual([]);
    expect(
      bookProblems({ ...ok, ready: false, blockers: ['ทดสอบ: ผ่าน 1/2'] }),
    ).toEqual([
      'ยังนัดตรวจรับไม่ได้ — ตรวจความพร้อมยังไม่ผ่าน: ทดสอบ: ผ่าน 1/2',
    ]);
    expect(
      bookProblems({
        ...ok,
        scheduledAt: new Date('2026-10-01T00:00:00Z'),
        openRound: 'A-1',
        milestoneStatus: 'achieved',
      }),
    ).toHaveLength(3);
    expect(bookProblems({ ...ok, scheduledAt: null })).toEqual([
      'ต้องระบุวันเวลานัดตรวจรับ',
    ]);
  });

  const base = {
    result: 'accepted',
    decidedOn: '2026-10-08',
    note: '',
    hasCertificate: true,
    items: [],
    today: '2026-10-08',
  };

  it('accepted carries the signed certificate', () => {
    expect(resultProblems(base)).toEqual([]);
    expect(resultProblems({ ...base, hasCertificate: false })).toEqual([
      'ต้องแนบใบตรวจรับที่ลูกค้าลงนามแล้ว',
    ]);
  });

  it('accepted with conditions lists each open point with its date', () => {
    expect(resultProblems({ ...base, result: 'conditional' })).toEqual([
      'ผ่านแบบมีเงื่อนไข: ต้องระบุรายการค้างอย่างน้อย 1 ข้อ',
    ]);
    expect(
      resultProblems({
        ...base,
        result: 'conditional',
        items: [{ text: 'ป้ายชื่อห้อง', dueOn: null }],
      }),
    ).toEqual(['รายการค้างข้อ 1: ต้องระบุวันแก้ไข']);
  });

  it('rejected says why; no certificate needed; never a future date', () => {
    expect(
      resultProblems({
        ...base,
        result: 'rejected',
        hasCertificate: false,
        note: 'ภาพไม่ชัด',
      }),
    ).toEqual([]);
    expect(
      resultProblems({ ...base, result: 'rejected', decidedOn: '2026-10-09' }),
    ).toEqual(['วันที่ตรวจรับต้องไม่เกินวันนี้', 'ไม่ผ่าน: ต้องระบุเหตุผล']);
  });

  it('open points are followed until every one is done', () => {
    expect(
      followUp(
        [
          { status: 'open', dueOn: '2026-10-01' },
          { status: 'open', dueOn: '2026-10-20' },
          { status: 'done', dueOn: '2026-09-01' },
        ],
        '2026-10-08',
      ),
    ).toEqual({ open: 2, overdue: 1, closed: false });
    expect(followUp([], '2026-10-08').closed).toBe(true);
  });

  it('the customer accepting meets every criterion not yet met', () => {
    expect(
      criteriaAccepted(
        [
          { text: 'ก', met: true, metAt: 'x', metBy: 'u1' },
          { text: 'ข', met: false },
        ],
        'u2',
        'now',
      ),
    ).toEqual([
      { text: 'ก', met: true, metAt: 'x', metBy: 'u1' },
      { text: 'ข', met: true, metAt: 'now', metBy: 'u2' },
    ]);
  });
});
