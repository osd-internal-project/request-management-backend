import { MART_TABLES } from './data-mart.repository';

const sql = () =>
  MART_TABLES.find((step) => step.table === 'fact_utilization')!.sql.join('\n');

describe('CD-235 utilization mart', () => {
  it('approved timesheets and approved leave only', () => {
    expect(sql()).toContain(`t.status = 'approved'`);
    expect(sql()).toContain(`l.status = 'approved'`);
  });

  it('working days follow the company calendar: weekdays less holidays', () => {
    expect(sql()).toContain('extract(isodow FROM d)::int = ANY (k.weekdays)');
    expect(sql()).toContain(`NOT (k.holidays ? to_char(d, 'YYYY-MM-DD'))`);
  });

  it('no leave that day counts as none (LEAST ignores NULL in Postgres)', () => {
    expect(sql()).toContain('COALESCE(lv.hours, 0)');
  });

  it('hours only — Metabase reads `mart`, so no rate or cost', () => {
    expect(sql()).not.toMatch(/hr_labor_rates|costPerManday|cost/i);
  });
});
