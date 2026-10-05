/**
 * CD-244 แผนบำรุงรักษาตามรอบ — the pure part: the rounds of a plan, when a
 * round's work order opens, when a round is late, and when a cover with no
 * contract gets its service-contract offer.
 */

export const PM_INTERVALS = {
  monthly: 1,
  quarterly: 3,
  semiannual: 6,
  yearly: 12,
} as const;

export type PmInterval = keyof typeof PM_INTERVALS;

export const MAX_LEAD_DAYS = 90;
const DAY_MS = 86_400_000;

const asDate = (day: string) => new Date(`${day}T00:00:00Z`);
const asDay = (date: Date) => date.toISOString().slice(0, 10);

/** `months` after a date, clamped to the month's last day (31 Jan + 1 = 28/29 Feb). */
export function addMonths(day: string, months: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const total = m - 1 + months;
  const year = y + Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return asDay(new Date(Date.UTC(year, month, Math.min(d, last))));
}

export function daysBetween(from: string, to: string): number {
  return Math.round((asDate(to).getTime() - asDate(from).getTime()) / DAY_MS);
}

/**
 * Each round's due date: one interval after the cover starts, then every
 * interval, while still inside the cover — and no more rounds than its
 * preventive quota (null = no cap).
 */
export function pmSchedule(input: {
  startOn: string;
  endOn: string;
  interval: PmInterval;
  quota: number | null;
}): string[] {
  const step = PM_INTERVALS[input.interval];
  const due: string[] = [];
  for (let k = 1; k <= 240; k += 1) {
    const day = addMonths(input.startOn, k * step);
    if (day > input.endOn) break;
    if (input.quota !== null && due.length >= input.quota) break;
    due.push(day);
  }
  return due;
}

export function planProblems(input: {
  interval: string;
  leadDays: number;
}): string[] {
  const problems: string[] = [];
  if (!(input.interval in PM_INTERVALS)) {
    problems.push('รอบต้องเป็น รายเดือน รายไตรมาส ครึ่งปี หรือรายปี');
  }
  if (
    !Number.isInteger(input.leadDays) ||
    input.leadDays < 0 ||
    input.leadDays > MAX_LEAD_DAYS
  ) {
    problems.push(`เปิดใบงานล่วงหน้าได้ 0–${MAX_LEAD_DAYS} วัน`);
  }
  return problems;
}

/** A planned round opens its work order `leadDays` before it is due. */
export function opensNow(dueOn: string, today: string, leadDays: number) {
  return daysBetween(today, dueOn) <= leadDays;
}

/** Past its due date and not done (nor skipped). */
export function isOverdue(
  round: { status: string; dueOn: string },
  today: string,
) {
  return !['done', 'skipped'].includes(round.status) && round.dueOn < today;
}

/** The case behind the round's work order is done. */
export const DONE_STATUSES = ['completed', 'approved', 'closed'];

/**
 * A cover with no contract behind it: its offer opens `openDays` before its
 * end, and each reminder step reached once while the deal is open.
 */
export function offerDue(endOn: string, today: string, openDays: number) {
  const left = daysBetween(today, endOn);
  return left >= 0 && left <= openDays;
}

export function remindersReached(
  endOn: string,
  today: string,
  remindDays: readonly number[],
  done: readonly number[],
): number[] {
  const left = daysBetween(today, endOn);
  return remindDays.filter((days) => left <= days && !done.includes(days));
}
