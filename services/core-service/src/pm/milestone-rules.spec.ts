import {
  achieveProblems,
  matchDeliverable,
  mergeCriteria,
  milestoneProblems,
  milestonesFromSchedule,
  readCriteria,
} from './milestone-rules';

describe('CD-182 criteria', () => {
  it('keeps the tick of a criterion kept, starts new ones open, drops blanks and repeats', () => {
    const previous = [
      { text: 'ภาพชัดทุกจุด', met: true, metAt: '2026-10-01', metBy: 'u1' },
      { text: 'บันทึกย้อนหลัง 30 วัน', met: false, metAt: null, metBy: null },
    ];
    expect(
      mergeCriteria(
        [' ภาพชัดทุกจุด ', '', 'อบรมผู้ใช้', 'อบรมผู้ใช้'],
        previous,
      ),
    ).toEqual([
      previous[0],
      { text: 'อบรมผู้ใช้', met: false, metAt: null, metBy: null },
    ]);
  });

  it('reads whatever is stored', () => {
    expect(readCriteria(null)).toEqual([]);
    expect(readCriteria([{ text: 'ก', met: true }, { met: true }, 3])).toEqual([
      { text: 'ก', met: true, metAt: null, metBy: null },
    ]);
  });
});

describe('CD-182 milestoneProblems', () => {
  it('a milestone that unlocks a payment must be measurable', () => {
    expect(
      milestoneProblems({ title: 'ส่งมอบ', criteria: [], installmentId: 'i1' }),
    ).toHaveLength(1);
    expect(
      milestoneProblems({
        title: 'ประชุมเปิดงาน',
        criteria: [],
        installmentId: null,
      }),
    ).toEqual([]);
    expect(
      milestoneProblems({ title: ' ', criteria: [], installmentId: null }),
    ).toEqual(['ต้องระบุชื่อหมุดหมาย']);
  });
});

describe('CD-182 achieveProblems', () => {
  const ok = {
    status: 'planned',
    criteria: [{ text: 'ก', met: true, metAt: null, metBy: null }],
    evidenceNote: 'ทดสอบร่วมกับลูกค้าแล้ว',
    achievedOn: '2026-10-01',
    today: '2026-10-02',
  };

  it('achieves once every criterion is met, with evidence, not in the future', () => {
    expect(achieveProblems(ok)).toEqual([]);
  });

  it('refuses an open criterion, no evidence, a future day, or twice', () => {
    expect(
      achieveProblems({
        ...ok,
        criteria: [
          ...ok.criteria,
          { text: 'ข', met: false, metAt: null, metBy: null },
        ],
      }),
    ).toEqual(['ยังมีเกณฑ์ที่ไม่ได้ยืนยัน 1 ข้อ']);
    expect(achieveProblems({ ...ok, evidenceNote: ' ' })).toHaveLength(1);
    expect(achieveProblems({ ...ok, achievedOn: '2026-10-03' })).toHaveLength(
      1,
    );
    expect(achieveProblems({ ...ok, status: 'achieved' })).toHaveLength(1);
    expect(achieveProblems({ ...ok, criteria: [] })).toHaveLength(1);
  });
});

describe('CD-182 milestonesFromSchedule', () => {
  const deliverables = [
    { title: 'ระบบกล้องพร้อมใช้งาน', criteria: ['ภาพชัดทุกจุด', 'อบรมผู้ใช้'] },
    { title: 'คู่มือ', criteria: ['ส่งไฟล์ PDF'] },
  ];
  const schedule = [
    {
      id: 'i1',
      seq: 1,
      kind: 'deposit',
      label: 'มัดจำ',
      dueOn: null,
      milestone: null,
    },
    {
      id: 'i2',
      seq: 2,
      kind: 'progress',
      label: 'งวด 2',
      dueOn: new Date('2027-01-31T00:00:00Z'),
      milestone: 'ระบบกล้องพร้อมใช้งาน',
    },
    {
      id: 'i3',
      seq: 3,
      kind: 'final',
      label: 'งวดสุดท้าย',
      dueOn: null,
      milestone: null,
    },
    {
      id: 'i4',
      seq: 4,
      kind: 'retention',
      label: 'ประกันผลงาน',
      dueOn: null,
      milestone: null,
    },
  ];

  it('one per installment that waits on work, criteria from the matching deliverable', () => {
    const drafts = milestonesFromSchedule(schedule, deliverables, new Set());
    expect(drafts.map((draft) => draft.installmentId)).toEqual(['i2', 'i3']);
    expect(drafts[0]).toMatchObject({
      title: 'ระบบกล้องพร้อมใช้งาน',
      dueOn: new Date('2027-01-31T00:00:00Z'),
    });
    expect(drafts[0].criteria.map((item) => item.text)).toEqual([
      'ภาพชัดทุกจุด',
      'อบรมผู้ใช้',
    ]);
    expect(drafts[1]).toMatchObject({ title: 'งวดสุดท้าย', criteria: [] });
  });

  it('skips installments already tied', () => {
    expect(
      milestonesFromSchedule(schedule, deliverables, new Set(['i2'])).map(
        (draft) => draft.installmentId,
      ),
    ).toEqual(['i3']);
  });

  it('matches a deliverable loosely, by name', () => {
    expect(matchDeliverable('ส่งคู่มือ', deliverables)?.title).toBe('คู่มือ');
    expect(matchDeliverable('อื่น ๆ', deliverables)).toBeNull();
  });
});
