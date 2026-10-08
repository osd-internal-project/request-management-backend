import {
  byRisk,
  healthFactors,
  healthThresholds,
  projectHealth,
  weekStart,
  type HealthFacts,
} from './health-rules';

const calm: HealthFacts = {
  variance: 2,
  milestonesLate: 0,
  risksHigh: 0,
  risksCritical: 0,
  issuesOverdue: 0,
  costGrowthPct: 0,
  paymentsOverdue: 0,
};
const thresholds = { amber: 20, red: 40 };

describe('CD-192 project health', () => {
  it('a project on plan with nothing late is green with no factors', () => {
    expect(projectHealth(calm, thresholds)).toEqual({
      score: 0,
      level: 'green',
      factors: [],
    });
  });

  it('points add up, each kind capped, the largest first', () => {
    const health = projectHealth(
      {
        variance: -12,
        milestonesLate: 3,
        risksHigh: 1,
        risksCritical: 2,
        issuesOverdue: 6,
        costGrowthPct: 12,
        paymentsOverdue: 1,
      },
      thresholds,
    );
    expect(health.factors.map((f) => [f.key, f.points])).toEqual([
      ['milestones', 30],
      ['risks', 30],
      ['issues', 20],
      ['behind', 15],
      ['cost', 10],
      ['payments', 10],
    ]);
    expect(health).toMatchObject({ score: 115, level: 'red' });
  });

  it('amber between the thresholds', () => {
    expect(
      projectHealth(
        { ...calm, milestonesLate: 1, paymentsOverdue: 1 },
        thresholds,
      ).level,
    ).toBe('amber');
  });

  it('no dated plan or budget adds nothing', () => {
    expect(
      healthFactors({ ...calm, variance: null, costGrowthPct: null }),
    ).toEqual([]);
  });

  it('thresholds default, and red never sits below amber', () => {
    expect(healthThresholds(null, null)).toEqual({ amber: 20, red: 40 });
    expect(healthThresholds(50, 30)).toEqual({ amber: 50, red: 50 });
  });

  it('the portfolio shows red first, then the higher score', () => {
    const rows = [
      { projectNo: 'P-1', health: { level: 'green' as const, score: 0 } },
      { projectNo: 'P-2', health: { level: 'red' as const, score: 45 } },
      { projectNo: 'P-3', health: { level: 'amber' as const, score: 25 } },
      { projectNo: 'P-4', health: { level: 'red' as const, score: 60 } },
    ];
    expect(byRisk(rows).map((row) => row.projectNo)).toEqual([
      'P-4',
      'P-2',
      'P-3',
      'P-1',
    ]);
  });

  it('a report covers the Monday-based week', () => {
    expect(weekStart('2026-10-01')).toBe('2026-09-28'); // Thursday
    expect(weekStart('2026-09-28')).toBe('2026-09-28'); // Monday
    expect(weekStart('2026-10-04')).toBe('2026-09-28'); // Sunday
  });
});

describe('CD-176 work not yet received', () => {
  it('counts against health until the manager receives it', () => {
    expect(healthFactors({ ...calm, intake: 'returned' })).toEqual([
      expect.objectContaining({
        key: 'intake',
        points: 10,
        detail: 'ตีกลับแล้ว รอทีมขาย/เทคนิคแก้',
      }),
    ]);
    expect(healthFactors({ ...calm, intake: null })).toEqual([]);
  });
});
