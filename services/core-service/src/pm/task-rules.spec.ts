import { reportProblems, statusStamps } from './task-rules';

describe('CD-181 reporting work', () => {
  const ok = {
    summary: false,
    status: 'open',
    note: 'เดินสายแล้ว',
    to: null,
    files: 0,
  };

  it('takes a note, a file, or a status move', () => {
    expect(reportProblems(ok)).toEqual([]);
    expect(reportProblems({ ...ok, note: '', files: 1 })).toEqual([]);
    expect(reportProblems({ ...ok, note: '', to: 'done' })).toEqual([]);
    expect(reportProblems({ ...ok, note: ' ' })).toHaveLength(1);
  });

  it('refuses a summary, a cancelled task, an unknown status, too many files', () => {
    expect(reportProblems({ ...ok, summary: true })).toHaveLength(1);
    expect(reportProblems({ ...ok, status: 'cancelled' })).toHaveLength(1);
    expect(reportProblems({ ...ok, to: 'cancelled' })).toHaveLength(1);
    expect(reportProblems({ ...ok, files: 11 })).toHaveLength(1);
  });
});

describe('CD-181 status stamps', () => {
  const now = new Date('2026-10-05T03:00:00Z');
  const earlier = new Date('2026-10-01T03:00:00Z');

  it('starting records the start once; finishing records when and who', () => {
    expect(
      statusStamps(
        { status: 'open', startedAt: null, doneAt: null },
        'in_progress',
        now,
        'u1',
      ),
    ).toEqual({
      status: 'in_progress',
      startedAt: now,
      doneAt: null,
      doneBy: null,
    });
    expect(
      statusStamps(
        { status: 'in_progress', startedAt: earlier, doneAt: null },
        'done',
        now,
        'u1',
      ),
    ).toEqual({
      status: 'done',
      startedAt: earlier,
      doneAt: now,
      doneBy: 'u1',
    });
  });

  it('finishing straight away also starts it; reopening clears the finish; no move, no stamp', () => {
    expect(
      statusStamps(
        { status: 'open', startedAt: null, doneAt: null },
        'done',
        now,
        'u1',
      ),
    ).toMatchObject({ startedAt: now, doneAt: now });
    expect(
      statusStamps(
        { status: 'done', startedAt: earlier, doneAt: now },
        'in_progress',
        now,
        'u1',
      ),
    ).toEqual({
      status: 'in_progress',
      startedAt: earlier,
      doneAt: null,
      doneBy: null,
    });
    expect(
      statusStamps(
        { status: 'open', startedAt: null, doneAt: null },
        'open',
        now,
        'u1',
      ),
    ).toBeNull();
  });
});
