/**
 * CD-247 รายงานผลบริการ — the pure part: a period's jobs measured against
 * the levels committed (met / missed, response and resolution apart), PM
 * rounds done, and the penalty the contract's terms (CD-154) put on misses.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
export const DONE = ['completed', 'approved', 'closed'];

export interface JobClock {
  severity: string | null;
  status: string;
  /** When the work was done (completed), or null if still open. */
  doneAt: Date | null;
  responseDueAt: Date | null;
  respondedAt: Date | null;
  responseBreachedAt: Date | null;
  dueAt: Date | null;
  breachedAt: Date | null;
}

export type Outcome = 'met' | 'missed' | 'pending' | 'none';

/** Responded in time, late, not yet (still in time), or no response clock. */
export function responseOutcome(job: JobClock, now: Date): Outcome {
  if (!job.responseDueAt) return 'none';
  if (job.respondedAt) {
    return job.respondedAt <= job.responseDueAt && !job.responseBreachedAt
      ? 'met'
      : 'missed';
  }
  if (job.responseBreachedAt || job.responseDueAt < now) return 'missed';
  return 'pending';
}

/** Done in time, late, still open and in time, or no resolution clock. */
export function resolutionOutcome(job: JobClock, now: Date): Outcome {
  if (!job.dueAt) return 'none';
  if (DONE.includes(job.status) && job.doneAt) {
    return job.doneAt <= job.dueAt && !job.breachedAt ? 'met' : 'missed';
  }
  if (job.breachedAt || job.dueAt < now) return 'missed';
  return 'pending';
}

/** Hours past the resolution due time (done, or still open now); 0 if in time. */
export function lateHours(job: JobClock, now: Date): number {
  if (!job.dueAt) return 0;
  const end = DONE.includes(job.status) && job.doneAt ? job.doneAt : now;
  return Math.max(
    0,
    Math.round(((end.getTime() - job.dueAt.getTime()) / HOUR_MS) * 10) / 10,
  );
}

export interface SeverityFigures {
  severity: string;
  jobs: number;
  responseMet: number;
  responseMissed: number;
  resolutionMet: number;
  resolutionMissed: number;
  open: number;
  /** % met of those measured (met + missed); null when none measured. */
  responsePct: number | null;
  resolutionPct: number | null;
}

const pct = (met: number, missed: number) =>
  met + missed ? Math.round((met / (met + missed)) * 1000) / 10 : null;

/** Per severity, and a total row (`severity` = 'all'). */
export function slaFigures(
  jobs: readonly JobClock[],
  now: Date,
): SeverityFigures[] {
  const order = ['critical', 'high', 'medium', 'low'];
  const rows = new Map<string, SeverityFigures>();
  const blank = (severity: string): SeverityFigures => ({
    severity,
    jobs: 0,
    responseMet: 0,
    responseMissed: 0,
    resolutionMet: 0,
    resolutionMissed: 0,
    open: 0,
    responsePct: null,
    resolutionPct: null,
  });
  const total = blank('all');
  for (const job of jobs) {
    const key = job.severity ?? 'medium';
    const row = rows.get(key) ?? blank(key);
    const response = responseOutcome(job, now);
    const resolution = resolutionOutcome(job, now);
    for (const target of [row, total]) {
      target.jobs += 1;
      if (response === 'met') target.responseMet += 1;
      if (response === 'missed') target.responseMissed += 1;
      if (resolution === 'met') target.resolutionMet += 1;
      if (resolution === 'missed') target.resolutionMissed += 1;
      if (!DONE.includes(job.status)) target.open += 1;
    }
    rows.set(key, row);
  }
  const out = [...rows.values()].sort(
    (a, b) => order.indexOf(a.severity) - order.indexOf(b.severity),
  );
  for (const row of [...out, total]) {
    row.responsePct = pct(row.responseMet, row.responseMissed);
    row.resolutionPct = pct(row.resolutionMet, row.resolutionMissed);
  }
  return [...out, total];
}

export interface PenaltyTerms {
  ratePct: number | null;
  /** day · week · month · occurrence */
  period: string | null;
  capPct: number | null;
  capAmount: number | null;
  contractValue: number | null;
}

/**
 * The penalty the contract puts on resolution misses: its rate on the basis
 * amount (entered for the report — e.g. the monthly fee), per miss
 * (`occurrence`) or per day / week / month late (each miss rounded up), held
 * to its cap (an amount, or a % of the contract value). An estimate for a
 * person to confirm, never charged by itself.
 */
export function penaltyEstimate(
  terms: PenaltyTerms,
  basisAmount: number | null,
  misses: readonly { lateHours: number }[],
): {
  amount: number | null;
  units: number;
  capped: boolean;
  cap: number | null;
} {
  if (
    !terms.ratePct ||
    !terms.period ||
    basisAmount === null ||
    !misses.length
  ) {
    return { amount: null, units: 0, capped: false, cap: null };
  }
  const days = (hours: number) => Math.max(1, Math.ceil(hours / 24));
  const units =
    terms.period === 'occurrence'
      ? misses.length
      : misses.reduce((sum, miss) => {
          const d = days(miss.lateHours);
          if (terms.period === 'week') return sum + Math.ceil(d / 7);
          if (terms.period === 'month') return sum + Math.ceil(d / 30);
          return sum + d;
        }, 0);
  const raw = Math.round(units * basisAmount * terms.ratePct) / 100;
  const caps = [
    terms.capAmount,
    terms.capPct !== null && terms.contractValue !== null
      ? Math.round(terms.contractValue * terms.capPct) / 100
      : null,
  ].filter((value): value is number => value !== null);
  const cap = caps.length ? Math.min(...caps) : null;
  const amount = cap !== null ? Math.min(raw, cap) : raw;
  return { amount, units, capped: cap !== null && raw > cap, cap };
}

/** A period: valid dates, not reversed, no longer than a year. */
export function periodProblems(from: string, to: string): string[] {
  const ok = (d: string) =>
    /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d));
  if (!ok(from) || !ok(to)) return ['ช่วงวันที่ไม่ถูกต้อง'];
  if (to < from) return ['วันสิ้นสุดต้องไม่ก่อนวันเริ่ม'];
  if ((Date.parse(to) - Date.parse(from)) / DAY_MS > 366) {
    return ['รายงานได้ไม่เกิน 1 ปีต่อฉบับ'];
  }
  return [];
}
