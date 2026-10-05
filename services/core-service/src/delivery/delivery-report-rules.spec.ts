import {
  aging,
  agingOf,
  monthsBack,
  onTimeRate,
} from './delivery-report-rules';

describe('CD-256 delivery report rules', () => {
  it('ages overdue installments into buckets', () => {
    expect(agingOf(1)).toBe('1-30');
    expect(agingOf(30)).toBe('1-30');
    expect(agingOf(31)).toBe('31-60');
    expect(agingOf(90)).toBe('61-90');
    expect(agingOf(365)).toBe('90+');
    expect(
      aging([
        { daysOverdue: 5, amount: 100 },
        { daysOverdue: 10, amount: 50 },
        { daysOverdue: 120, amount: 7 },
      ]),
    ).toEqual({
      '1-30': { count: 2, amount: 150 },
      '31-60': { count: 0, amount: 0 },
      '61-90': { count: 0, amount: 0 },
      '90+': { count: 1, amount: 7 },
    });
  });

  it('on-time rate leaves out phases without a due day', () => {
    expect(
      onTimeRate([
        { onTime: true },
        { onTime: false },
        { onTime: true },
        { onTime: null },
      ]),
    ).toEqual({ counted: 3, onTime: 2, late: 1, noDueDay: 1, pct: 66.7 });
    expect(onTimeRate([]).pct).toBeNull();
  });

  it('months back cross the year', () => {
    expect(monthsBack('2026-02-15', 0)).toBe('2026-02');
    expect(monthsBack('2026-02-15', 3)).toBe('2025-11');
  });
});
