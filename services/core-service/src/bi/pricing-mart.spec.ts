import { MART_TABLES } from './data-mart.repository';
import {
  COUNTED_QUOTATION_STATUSES,
  martTableName,
  PRICING_MART_TABLES,
} from './pricing-mart';

describe('CD-208 pricing mart', () => {
  it('rebuilds quotation lines and exceptions in mart_pricing, never in mart', () => {
    expect(PRICING_MART_TABLES.map((step) => step.table)).toEqual([
      'pricing.fact_quotation_lines',
      'pricing.fact_pricing_exceptions',
    ]);
    const sql = PRICING_MART_TABLES.flatMap((step) => step.sql).join('\n');
    expect(sql).not.toMatch(/\bmart\.(?!refresh_log)/);
    expect(sql).toMatch(/INSERT INTO mart_pricing\.fact_quotation_lines/);
  });

  it('SCOPE-04: margins stay out of the mart Metabase reads', () => {
    const mart = MART_TABLES.flatMap((step) => step.sql).join('\n');
    expect(mart).not.toMatch(/lineCost|marginPct|"discountPct"|systemPrice/);
  });

  it('counts versions past approval only, and skips superseded exceptions', () => {
    expect([...COUNTED_QUOTATION_STATUSES]).toEqual([
      'approved',
      'sent',
      'accepted',
      'declined',
    ]);
    const exceptions = PRICING_MART_TABLES[1].sql.join('\n');
    expect(exceptions).toContain(`pe.decision <> 'superseded'`);
  });

  it('months are Bangkok months of UTC-stored timestamps', () => {
    const sql = PRICING_MART_TABLES.flatMap((step) => step.sql).join('\n');
    expect(sql).toContain(`AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Bangkok'`);
  });

  it('table names resolve to their schema', () => {
    expect(martTableName('pricing.fact_quotation_lines')).toBe(
      'mart_pricing.fact_quotation_lines',
    );
    expect(martTableName('fact_sales')).toBe('mart.fact_sales');
  });
});
