import {
  linkProblems,
  milestoneForecast,
  scheduleShifts,
  slippedMilestones,
  schedulePlan,
  wbsCodes,
  workdaysFrom,
  wouldNest,
  type PlanTask,
} from './plan-rules';

const calendar = { workingWeekdays: [1, 2, 3, 4, 5], holidays: ['2026-10-13'] };
const task = (
  id: string,
  durationDays: number,
  over: Partial<PlanTask> = {},
): PlanTask => ({
  id,
  parentId: null,
  seq: 1,
  durationDays,
  status: 'open',
  ...over,
});
const link = (predecessorId: string, successorId: string, lagDays = 0) => ({
  predecessorId,
  successorId,
  lagDays,
});

describe('CD-177 working days', () => {
  it('skips weekends and the company holidays', () => {
    // 1 Oct 2026 is a Thursday; 13 Oct is a holiday
    expect(workdaysFrom('2026-10-01', 10, calendar)).toEqual([
      '2026-10-01',
      '2026-10-02',
      '2026-10-05',
      '2026-10-06',
      '2026-10-07',
      '2026-10-08',
      '2026-10-09',
      '2026-10-12',
      '2026-10-14',
      '2026-10-15',
    ]);
  });
});

describe('CD-177 schedulePlan', () => {
  // A 3d → B 2d → D (point) ; C 1d → D
  const tasks = [task('A', 3), task('B', 2), task('C', 1), task('D', 0)];
  const links = [link('A', 'B'), link('B', 'D'), link('C', 'D')];

  it('dates each task from the start, its predecessors and the calendar', () => {
    const plan = schedulePlan(tasks, links, '2026-10-01', calendar)!;
    expect(plan.tasks.get('A')).toMatchObject({
      start: '2026-10-01',
      finish: '2026-10-05',
    });
    expect(plan.tasks.get('B')).toMatchObject({
      start: '2026-10-06',
      finish: '2026-10-07',
    });
    // a point in time on the day after its last predecessor
    expect(plan.tasks.get('D')).toMatchObject({
      start: '2026-10-08',
      finish: '2026-10-08',
    });
    expect(plan.finish).toBe('2026-10-08');
  });

  it('gives the float, and the path without it is critical', () => {
    const plan = schedulePlan(tasks, links, '2026-10-01', calendar)!;
    expect(
      ['A', 'B', 'C', 'D'].map((id) => [
        id,
        plan.tasks.get(id)!.floatDays,
        plan.tasks.get(id)!.critical,
      ]),
    ).toEqual([
      ['A', 0, true],
      ['B', 0, true],
      ['C', 4, false],
      ['D', 0, true],
    ]);
  });

  it('adds the lag in working days, and starts after a weekend', () => {
    const plan = schedulePlan(
      [task('A', 2), task('B', 1)],
      [link('A', 'B', 2)],
      '2026-10-01',
      calendar,
    )!;
    // A: Thu 1 – Fri 2; B: two working days after Monday 5 → Wed 7
    expect(plan.tasks.get('B')!.start).toBe('2026-10-07');
  });

  it('a summary spans its children; cancelled work is left out', () => {
    const plan = schedulePlan(
      [
        task('P', 99),
        task('A', 3, { parentId: 'P' }),
        task('B', 2, { parentId: 'P', seq: 2 }),
        task('X', 50, { status: 'cancelled' }),
      ],
      [link('A', 'B')],
      '2026-10-01',
      calendar,
    )!;
    expect(plan.tasks.get('P')).toMatchObject({
      start: '2026-10-01',
      finish: '2026-10-07',
      critical: true,
    });
    expect(plan.tasks.has('X')).toBe(false);
    expect(plan.finish).toBe('2026-10-07');
  });

  it('refuses a circle', () => {
    expect(
      schedulePlan(
        [task('A', 1), task('B', 1)],
        [link('A', 'B'), link('B', 'A')],
        '2026-10-01',
        calendar,
      ),
    ).toBeNull();
  });
});

describe('CD-177 the breakdown', () => {
  const tree = [
    task('p1', 0, { seq: 1 }),
    task('p2', 0, { seq: 2 }),
    task('c2', 1, { parentId: 'p1', seq: 2 }),
    task('c1', 1, { parentId: 'p1', seq: 1 }),
    task('g1', 1, { parentId: 'c1', seq: 1 }),
  ];

  it('numbers by the order of siblings', () => {
    expect(Object.fromEntries(wbsCodes(tree))).toEqual({
      p1: '1',
      c1: '1.1',
      g1: '1.1.1',
      c2: '1.2',
      p2: '2',
    });
  });

  it('links only work, never a summary, and never in a circle', () => {
    expect(linkProblems(tree, [link('p1', 'p2')]).join()).toContain(
      'มีงานย่อย',
    );
    expect(
      linkProblems(tree, [link('g1', 'c2'), link('c2', 'g1')]).join(),
    ).toContain('วนเป็นวง');
    expect(linkProblems(tree, [link('g1', 'c2')])).toEqual([]);
  });

  it('cannot move a task under its own child', () => {
    expect(wouldNest(tree, 'p1', 'g1')).toBe(true);
    expect(wouldNest(tree, 'g1', 'p2')).toBe(false);
  });
});

describe('CD-178 impact of a change', () => {
  const tasks = [
    { ...task('A', 3), milestoneId: null },
    { ...task('B', 2), milestoneId: 'm1' },
    { ...task('C', 1), milestoneId: 'm1' },
    { ...task('D', 1), milestoneId: 'm2' },
  ];
  const links = [link('A', 'B')];

  it('forecasts a milestone at the latest finish of its tasks', () => {
    const plan = schedulePlan(tasks, links, '2026-10-01', calendar)!;
    expect(Object.fromEntries(milestoneForecast(tasks, plan.tasks))).toEqual({
      m1: '2026-10-07',
      m2: '2026-10-01',
    });
  });

  it('lists what moves, and the milestones that slip', () => {
    const before = schedulePlan(tasks, links, '2026-10-01', calendar)!;
    const longer = tasks.map((row) =>
      row.id === 'A' ? { ...row, durationDays: 5 } : row,
    );
    const after = schedulePlan(longer, links, '2026-10-01', calendar)!;
    expect(scheduleShifts(before.tasks, after.tasks).map((s) => s.id)).toEqual([
      'A',
      'B',
    ]);
    expect(
      slippedMilestones(
        milestoneForecast(tasks, before.tasks),
        milestoneForecast(longer, after.tasks),
      ),
    ).toEqual([{ milestoneId: 'm1', from: '2026-10-07', to: '2026-10-09' }]);
  });
});
