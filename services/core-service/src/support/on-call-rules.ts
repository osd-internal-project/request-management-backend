import { localDay, type WorkingCalendar } from '../sla/business-hours';

/**
 * CD-241 ตารางเวรนอกเวลา — the pure part: when is "out of hours", whose turn
 * is it, and when does an unanswered case go to the backup.
 */

/** A rota span may cover at most this many days (a month's rotation). */
export const MAX_SHIFT_DAYS = 31;

/**
 * Outside the company's working window: before opening, from closing, or on
 * a weekend or holiday of its calendar — the same calendar the SLA clock
 * counts working hours on.
 */
export function outOfHours(at: Date, calendar: WorkingCalendar): boolean {
  const day = localDay(at, calendar);
  return (
    !day.workingDay ||
    day.minuteOfDay < calendar.workdayStartMinute ||
    day.minuteOfDay >= calendar.workdayEndMinute
  );
}

/** The local date whose rota answers for this moment (02:00 Tue = Tuesday's). */
export function rotaDay(at: Date, calendar: WorkingCalendar): string {
  return localDay(at, calendar).date;
}

export interface ShiftInput {
  startOn: string;
  endOn: string;
  primaryUserId: string;
  backupUserId: string | null;
}

export interface ShiftSpan {
  id: string;
  startOn: string;
  endOn: string;
}

const DAY_MS = 86_400_000;
const isDay = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

/** Inclusive days from start to end. */
export function spanDays(startOn: string, endOn: string): number {
  return (
    Math.round(
      (Date.parse(`${endOn}T00:00:00Z`) - Date.parse(`${startOn}T00:00:00Z`)) /
        DAY_MS,
    ) + 1
  );
}

/**
 * Why a span cannot be saved: dates, length, the backup being someone else,
 * and no overlap with another span of the company (one rota at a time —
 * otherwise "who is on call" has two answers).
 */
export function shiftProblems(
  input: ShiftInput,
  others: readonly ShiftSpan[],
): string[] {
  const problems: string[] = [];
  if (!isDay(input.startOn) || !isDay(input.endOn)) {
    return ['วันที่ไม่ถูกต้อง'];
  }
  if (input.endOn < input.startOn) {
    problems.push('วันสิ้นสุดต้องไม่ก่อนวันเริ่ม');
  } else if (spanDays(input.startOn, input.endOn) > MAX_SHIFT_DAYS) {
    problems.push(`ลงเวรได้ครั้งละไม่เกิน ${MAX_SHIFT_DAYS} วัน`);
  }
  if (input.backupUserId && input.backupUserId === input.primaryUserId) {
    problems.push('เวรสำรองต้องเป็นคนละคนกับเวรหลัก');
  }
  const clash = others.find(
    (other) => other.startOn <= input.endOn && other.endOn >= input.startOn,
  );
  if (clash) {
    problems.push(
      `ช่วงนี้ทับกับเวร ${clash.startOn} ถึง ${clash.endOn} ที่ลงไว้แล้ว`,
    );
  }
  return problems;
}

export type OnCallLevel = 'primary' | 'backup';

/**
 * Whom to send it to: the primary, unless away (leave, CD-232) — then the
 * backup, unless away too. Null: nobody on the rota can take it, and the
 * case stays with the type's receiver.
 */
export function pickOnCall(
  shift: { primaryUserId: string; backupUserId: string | null },
  away: ReadonlySet<string>,
): { userId: string; level: OnCallLevel } | null {
  if (!away.has(shift.primaryUserId)) {
    return { userId: shift.primaryUserId, level: 'primary' };
  }
  if (shift.backupUserId && !away.has(shift.backupUserId)) {
    return { userId: shift.backupUserId, level: 'backup' };
  }
  return null;
}

/** The primary has had `minutes` to receive it; 0 = never handed on. */
export function escalationDue(
  sentAt: Date,
  now: Date,
  minutes: number,
): boolean {
  return minutes > 0 && now.getTime() - sentAt.getTime() >= minutes * 60_000;
}
