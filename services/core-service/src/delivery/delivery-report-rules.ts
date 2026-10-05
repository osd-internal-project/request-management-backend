/**
 * CD-256 รายงานการส่งมอบ — the arithmetic of the report, apart from the
 * database: the on-time rate and how old the unpaid installments are.
 */

/** Ages of an overdue installment, in days past its due day. */
export const AGING_BUCKETS = [
  { key: '1-30', from: 1, to: 30 },
  { key: '31-60', from: 31, to: 60 },
  { key: '61-90', from: 61, to: 90 },
  { key: '90+', from: 91, to: Number.POSITIVE_INFINITY },
] as const;

export type AgingKey = (typeof AGING_BUCKETS)[number]['key'];

export function agingOf(daysOverdue: number): AgingKey {
  return (
    AGING_BUCKETS.find((b) => daysOverdue >= b.from && daysOverdue <= b.to) ??
    AGING_BUCKETS[0]
  ).key;
}

/** Sums the overdue amounts by age. */
export function aging(rows: { daysOverdue: number; amount: number }[]) {
  const sums = Object.fromEntries(
    AGING_BUCKETS.map((b) => [b.key, { count: 0, amount: 0 }]),
  ) as Record<AgingKey, { count: number; amount: number }>;
  for (const row of rows) {
    const bucket = sums[agingOf(row.daysOverdue)];
    bucket.count += 1;
    bucket.amount += row.amount;
  }
  return sums;
}

/**
 * The on-time rate of accepted phases: accepted by the milestone's due day.
 * Phases without a due day are not counted either way.
 */
export function onTimeRate(rows: { onTime: boolean | null }[]) {
  const counted = rows.filter((r) => r.onTime !== null);
  const onTime = counted.filter((r) => r.onTime).length;
  return {
    counted: counted.length,
    onTime,
    late: counted.length - onTime,
    noDueDay: rows.length - counted.length,
    pct: counted.length
      ? Math.round((1000 * onTime) / counted.length) / 10
      : null,
  };
}

/** Bangkok YYYY-MM, `back` months before `today`'s month. */
export function monthsBack(today: string, back: number): string {
  const at = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
  at.setUTCMonth(at.getUTCMonth() - back);
  return at.toISOString().slice(0, 7);
}
