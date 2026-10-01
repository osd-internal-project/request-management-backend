import { changeFromIssue, issueOverdue, issueProblems } from './issue-rules';

describe('CD-184 an issue', () => {
  const ok = {
    title: 'อุปกรณ์มาไม่ครบ',
    severity: 'high',
    ownerUserId: 'u1',
    dueOn: '2026-10-10',
    costImpact: 5000,
  };

  it('needs an owner and a deadline', () => {
    expect(issueProblems(ok)).toEqual([]);
    expect(
      issueProblems({ ...ok, ownerUserId: null, dueOn: null }),
    ).toHaveLength(2);
    expect(
      issueProblems({ ...ok, severity: 'x', costImpact: -1 }),
    ).toHaveLength(2);
  });

  it('is late past its deadline while open', () => {
    expect(
      issueOverdue({ status: 'open', dueOn: '2026-10-10' }, '2026-10-11'),
    ).toBe(true);
    expect(
      issueOverdue({ status: 'open', dueOn: '2026-10-10' }, '2026-10-10'),
    ).toBe(false);
    expect(
      issueOverdue({ status: 'resolved', dueOn: '2026-10-10' }, '2026-10-11'),
    ).toBe(false);
  });

  it('becomes a change request with its days and its cost as one line', () => {
    expect(
      changeFromIssue({
        seq: 2,
        title: 'ต้องเดินสายใหม่',
        description: null,
        scheduleImpactDays: 3,
        costImpact: 5000,
      }),
    ).toEqual({
      title: 'I-2: ต้องเดินสายใหม่',
      reason: 'แก้ปัญหา I-2',
      schedule_days: 3,
      cost_lines: [
        {
          category: 'other',
          description: 'ผลกระทบจากปัญหา I-2',
          quantity: 1,
          unit_cost: 5000,
        },
      ],
    });
  });
});
