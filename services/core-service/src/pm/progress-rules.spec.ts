import {
  milestoneProgress,
  plannedProgress,
  reportedProblems,
  workdaysBetween,
  workProgress,
} from './progress-rules';

const calendar = { workingWeekdays: [1, 2, 3, 4, 5], holidays: [] };
const piece = (
  durationDays: number,
  status: string,
  start: string | null = null,
  finish: string | null = null,
) => ({ durationDays, status, start, finish });

describe('CD-188 progress from what closed', () => {
  it('weights done work by its working days; a point counts as one', () => {
    expect(
      workProgress([
        piece(6, 'done'),
        piece(3, 'in_progress'),
        piece(0, 'done'),
      ]),
    ).toBe(70);
    expect(workProgress([piece(5, 'cancelled')])).toBeNull();
  });

  it('counts achieved milestones, leaving out cancelled ones', () => {
    expect(
      milestoneProgress([
        { status: 'achieved' },
        { status: 'planned' },
        { status: 'planned' },
        { status: 'cancelled' },
      ]),
    ).toEqual({ achieved: 1, total: 3, pct: 33.3 });
  });
});

describe('CD-188 where the plan says it should be', () => {
  // Thu 1 Oct – Wed 7 Oct is 5 working days; Thu 8 – Fri 9 is 2
  const pieces = [
    piece(5, 'done', '2026-10-01', '2026-10-07'),
    piece(2, 'open', '2026-10-08', '2026-10-09'),
    piece(3, 'open', '2026-10-12', '2026-10-14'),
  ];

  it('counts working days on the calendar', () => {
    expect(workdaysBetween('2026-10-01', '2026-10-07', calendar)).toBe(5);
  });

  it('full for work past its finish, part while it runs, none before it starts', () => {
    expect(plannedProgress(pieces, '2026-09-30', calendar)).toBe(0);
    // first piece done (5) + one day of the second (1) of 10
    expect(plannedProgress(pieces, '2026-10-08', calendar)).toBe(60);
    expect(plannedProgress(pieces, '2026-10-20', calendar)).toBe(100);
  });

  it('cannot say without dates', () => {
    expect(
      plannedProgress([piece(1, 'open')], '2026-10-01', calendar),
    ).toBeNull();
  });
});

describe('CD-188 a reported figure', () => {
  it('needs a reason when it is far from the computed one', () => {
    expect(
      reportedProblems({ reportedPct: 55, computedPct: 50, reason: '' }),
    ).toEqual([]);
    expect(
      reportedProblems({ reportedPct: 70, computedPct: 50, reason: '' }),
    ).toHaveLength(1);
    expect(
      reportedProblems({
        reportedPct: 70,
        computedPct: 50,
        reason: 'งานติดตั้งเสร็จแต่ยังไม่ได้ปิดในระบบ',
      }),
    ).toEqual([]);
    expect(
      reportedProblems({ reportedPct: 120, computedPct: null, reason: '' }),
    ).toHaveLength(1);
  });
});
