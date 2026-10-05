import { MART_TABLES } from './data-mart.repository';

const sql = (table: string) =>
  MART_TABLES.find((step) => step.table === table)!.sql.join('\n');

describe('CD-256 delivery mart', () => {
  it('a phase is accepted by its first accepted or conditional round', () => {
    expect(sql('fact_delivery_phases')).toContain(
      `status IN ('accepted', 'conditional')`,
    );
    expect(sql('fact_delivery_phases')).toContain(
      'pa.decided_on <= m."dueOn"::date',
    );
  });

  it('cancelled phases, trips and rounds are left out', () => {
    const phases = sql('fact_delivery_phases');
    expect(phases).toContain(`m.status <> 'cancelled'`);
    expect(phases).toContain(`FILTER (WHERE status <> 'cancelled')`);
  });

  it('an installment falls due credit days after its invoice, as CD-193', () => {
    expect(sql('fact_receivables')).toContain(`b."invoicedOn"::date + 30`);
    expect(sql('fact_receivables')).toContain(`b."invoicedOn" IS NOT NULL`);
  });
});
