import {
  addMonths,
  isOverdue,
  offerDue,
  opensNow,
  planProblems,
  pmSchedule,
  remindersReached,
} from './pm-rules';

describe('CD-244 maintenance plan rules', () => {
  it('adds months, clamped to the month end', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonths('2026-11-15', 3)).toBe('2027-02-15');
  });

  it('lays rounds one interval apart inside the cover, capped by the quota', () => {
    expect(
      pmSchedule({
        startOn: '2026-01-01',
        endOn: '2026-12-31',
        interval: 'quarterly',
        quota: null,
      }),
    ).toEqual(['2026-04-01', '2026-07-01', '2026-10-01']);
    expect(
      pmSchedule({
        startOn: '2026-01-01',
        endOn: '2027-01-01',
        interval: 'quarterly',
        quota: null,
      }),
    ).toEqual(['2026-04-01', '2026-07-01', '2026-10-01', '2027-01-01']);
    expect(
      pmSchedule({
        startOn: '2026-01-01',
        endOn: '2026-12-31',
        interval: 'monthly',
        quota: 4,
      }),
    ).toHaveLength(4);
    expect(
      pmSchedule({
        startOn: '2026-01-01',
        endOn: '2026-06-30',
        interval: 'yearly',
        quota: null,
      }),
    ).toEqual([]);
  });

  it('checks a plan', () => {
    expect(planProblems({ interval: 'quarterly', leadDays: 14 })).toEqual([]);
    expect(planProblems({ interval: 'weekly', leadDays: 14 })).toHaveLength(1);
    expect(planProblems({ interval: 'monthly', leadDays: 91 })).toHaveLength(1);
  });

  it('opens a round ahead and calls it late once its day has passed undone', () => {
    expect(opensNow('2026-10-20', '2026-10-05', 14)).toBe(false);
    expect(opensNow('2026-10-19', '2026-10-05', 14)).toBe(true);
    expect(
      isOverdue({ status: 'opened', dueOn: '2026-10-04' }, '2026-10-05'),
    ).toBe(true);
    expect(
      isOverdue({ status: 'done', dueOn: '2026-10-04' }, '2026-10-05'),
    ).toBe(false);
    expect(
      isOverdue({ status: 'skipped', dueOn: '2026-10-04' }, '2026-10-05'),
    ).toBe(false);
    expect(
      isOverdue({ status: 'planned', dueOn: '2026-10-05' }, '2026-10-05'),
    ).toBe(false);
  });

  it('offers a contract before a cover ends, and reminds once per step', () => {
    expect(offerDue('2027-01-01', '2026-10-03', 90)).toBe(true);
    expect(offerDue('2027-01-01', '2026-10-02', 90)).toBe(false);
    expect(offerDue('2026-10-01', '2026-10-05', 90)).toBe(false);
    expect(remindersReached('2026-11-01', '2026-10-05', [60, 30], [])).toEqual([
      60, 30,
    ]);
    expect(
      remindersReached('2026-11-30', '2026-10-05', [60, 30], [60]),
    ).toEqual([]);
  });
});
