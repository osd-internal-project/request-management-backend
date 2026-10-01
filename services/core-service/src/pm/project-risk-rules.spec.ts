import {
  fromLegalIssues,
  fromSolutionRisks,
  levelOf,
  needsPlan,
  nextReviewOn,
  reviewOverdue,
  riskProblems,
} from './project-risk-rules';

describe('CD-183 taken over from the technical team and Legal', () => {
  it('takes the open Solution risks once, with their plan', () => {
    const rows = [
      {
        id: 'r1',
        title: 'สัญญาณรบกวน',
        description: '',
        likelihood: 4,
        impact: 4,
        mitigation: 'ใช้สายชีลด์',
        status: 'open',
      },
      {
        id: 'r2',
        title: 'ปิดแล้ว',
        description: '',
        likelihood: 2,
        impact: 2,
        mitigation: '',
        status: 'closed',
      },
    ];
    expect(fromSolutionRisks(rows, new Set())).toEqual([
      expect.objectContaining({
        sourceRef: 'solution:r1',
        source: 'technical',
        response: 'ใช้สายชีลด์',
      }),
    ]);
    expect(fromSolutionRisks(rows, new Set(['solution:r1']))).toEqual([]);
  });

  it('scores Legal issues by severity; one put to the executives at the top impact', () => {
    const drafts = fromLegalIssues(
      [
        {
          title: 'ค่าปรับไม่มีเพดาน',
          clause: '12',
          severity: 'high',
          escalate: true,
        },
        { title: 'ระยะเวลาแจ้งสั้น', severity: 'low' },
        { title: ' ' },
      ],
      'a1',
      new Set(),
    );
    expect(
      drafts.map((d) => [d.sourceRef, d.likelihood, d.impact, d.description]),
    ).toEqual([
      ['legal:a1:0', 4, 5, 'ข้อ 12'],
      ['legal:a1:1', 2, 2, null],
    ]);
    expect(levelOf(4, 5)).toBe('critical');
  });
});

describe('CD-183 before the executives', () => {
  const high = {
    status: 'open',
    likelihood: 4,
    impact: 3,
    ownerUserId: 'u1',
    response: 'มีแผน',
  };

  it('an open high risk without an owner or a plan', () => {
    expect(needsPlan(high)).toBe(false);
    expect(needsPlan({ ...high, response: ' ' })).toBe(true);
    expect(needsPlan({ ...high, ownerUserId: null })).toBe(true);
    expect(needsPlan({ ...high, likelihood: 2, response: null })).toBe(false);
    expect(needsPlan({ ...high, status: 'accepted', response: null })).toBe(
      false,
    );
  });

  it('a review past its day', () => {
    expect(nextReviewOn('2026-10-01', 14)).toBe('2026-10-15');
    expect(
      reviewOverdue(
        { status: 'open', nextReviewOn: '2026-10-15' },
        '2026-10-16',
      ),
    ).toBe(true);
    expect(
      reviewOverdue(
        { status: 'closed', nextReviewOn: '2026-10-15' },
        '2026-10-16',
      ),
    ).toBe(false);
  });

  it('a score of 1–5 each and a review cycle in range', () => {
    expect(
      riskProblems({
        title: 'x',
        likelihood: 3,
        impact: 5,
        reviewEveryDays: 14,
      }),
    ).toEqual([]);
    expect(
      riskProblems({ title: '', likelihood: 0, impact: 6, reviewEveryDays: 0 }),
    ).toHaveLength(4);
  });
});
