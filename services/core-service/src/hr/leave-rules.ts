/**
 * CD-232 — leave and availability, as pure arithmetic over `YYYY-MM-DD`
 * days. A working day is one of the company's working weekdays that is not
 * a company holiday (the same calendar SLA and the project plan read). A
 * working day holds `CAPACITY_HOURS`; leave takes all of it (or half, for a
 * morning or afternoon); bookings take their hours per day.
 */

export const CAPACITY_HOURS = 8;
export const LEAVE_PARTS = ['full', 'am', 'pm'] as const;
export type LeavePart = (typeof LEAVE_PARTS)[number];
/** Longest leave and widest availability window, in calendar days. */
export const MAX_LEAVE_DAYS = 120;
export const MAX_WINDOW_DAYS = 92;

const MS_DAY = 86_400_000;
const at = (day: string) => Date.parse(`${day}T00:00:00Z`);
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export interface WorkDays {
  /** ISO weekdays, 1 = Monday. */
  workingWeekdays: readonly number[];
  holidays: readonly string[];
}

export const DEFAULT_WORK_DAYS: WorkDays = {
  workingWeekdays: [1, 2, 3, 4, 5],
  holidays: [],
};

export function isDay(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && iso(at(value)) === value;
}

/** Every calendar day from `from` to `to`, both included. */
export function daysBetween(from: string, to: string) {
  const out: string[] = [];
  for (let ms = at(from); ms <= at(to); ms += MS_DAY) out.push(iso(ms));
  return out;
}

export function spanDays(from: string, to: string) {
  return Math.round((at(to) - at(from)) / MS_DAY) + 1;
}

export function isWorkingDay(day: string, calendar: WorkDays) {
  const weekday = ((new Date(at(day)).getUTCDay() + 6) % 7) + 1;
  return (
    calendar.workingWeekdays.includes(weekday) &&
    !calendar.holidays.includes(day)
  );
}

/** The working days a leave takes, each as a share of the day (1 or 0.5). */
export function leaveShares(
  start: string,
  end: string,
  part: LeavePart,
  calendar: WorkDays,
) {
  const share = part === 'full' ? 1 : 0.5;
  return daysBetween(start, end)
    .filter((day) => isWorkingDay(day, calendar))
    .map((day) => ({ day, share }));
}

/** What is wrong with a leave request, in Thai; empty when nothing is. */
export function leaveProblems(
  start: string,
  end: string,
  part: string,
  calendar: WorkDays,
) {
  if (!isDay(start) || !isDay(end)) return ['วันที่ไม่ถูกต้อง'];
  if (end < start) return ['วันสิ้นสุดต้องไม่ก่อนวันเริ่ม'];
  if (!(LEAVE_PARTS as readonly string[]).includes(part))
    return ['ช่วงเวลาลาไม่ถูกต้อง'];
  if (part !== 'full' && start !== end) return ['ลาครึ่งวันได้ทีละหนึ่งวัน'];
  if (spanDays(start, end) > MAX_LEAVE_DAYS)
    return [`ลาได้ครั้งละไม่เกิน ${MAX_LEAVE_DAYS} วัน`];
  if (!leaveShares(start, end, part as LeavePart, calendar).length)
    return ['ช่วงที่ลาไม่มีวันทำการ'];
  return [];
}

export interface LeaveSpan {
  startDate: string;
  endDate: string;
  part: string;
}

/** Two leaves clash when they share a day and not as a morning + afternoon. */
export function leavesClash(a: LeaveSpan, b: LeaveSpan) {
  if (a.endDate < b.startDate || b.endDate < a.startDate) return false;
  return a.part === 'full' || b.part === 'full' || a.part === b.part;
}

/** Leave days per calendar year (a leave may cross New Year). */
export function daysByYear(
  leave: LeaveSpan,
  calendar: WorkDays,
): Map<number, number> {
  const out = new Map<number, number>();
  for (const { day, share } of leaveShares(
    leave.startDate,
    leave.endDate,
    leave.part as LeavePart,
    calendar,
  )) {
    const year = Number(day.slice(0, 4));
    out.set(year, (out.get(year) ?? 0) + share);
  }
  return out;
}

export interface BookingSpan {
  id: string;
  projectId: string;
  startDate: string;
  endDate: string;
  hoursPerDay: number;
}

export interface LeaveOnDay extends LeaveSpan {
  id: string;
  status: string;
  /** Hidden from those who may not know why someone is away. */
  typeName: string | null;
}

export interface DayAvailability {
  day: string;
  working: boolean;
  capacity: number;
  leaveHours: number;
  /** A leave still waiting for approval (counted as away). */
  pendingLeave: boolean;
  leaveType: string | null;
  booked: { bookingId: string; projectId: string; hours: number }[];
  bookedHours: number;
  free: number;
}

/** One person's days: capacity, leave, bookings and what is left. */
export function availabilityDays(
  days: string[],
  calendar: WorkDays,
  leaves: LeaveOnDay[],
  bookings: BookingSpan[],
): DayAvailability[] {
  return days.map((day) => {
    const working = isWorkingDay(day, calendar);
    const capacity = working ? CAPACITY_HOURS : 0;
    // Leave over a weekend or holiday takes nothing there (and says nothing).
    const todays = working
      ? leaves.filter((leave) => leave.startDate <= day && day <= leave.endDate)
      : [];
    const leaveHours = Math.min(
      capacity,
      todays.reduce(
        (sum, leave) => sum + (leave.part === 'full' ? capacity : capacity / 2),
        0,
      ),
    );
    const booked = working
      ? bookings
          .filter(
            (booking) => booking.startDate <= day && day <= booking.endDate,
          )
          .map((booking) => ({
            bookingId: booking.id,
            projectId: booking.projectId,
            hours: booking.hoursPerDay,
          }))
      : [];
    const bookedHours = booked.reduce((sum, row) => sum + row.hours, 0);
    return {
      day,
      working,
      capacity,
      leaveHours,
      pendingLeave: todays.some((leave) => leave.status === 'pending'),
      leaveType: todays.find((leave) => leave.typeName)?.typeName ?? null,
      booked,
      bookedHours,
      free: capacity - leaveHours - bookedHours,
    };
  });
}

/** Days a new booking would push past what the person has free. */
export function overbookedDays(
  current: DayAvailability[],
  hoursPerDay: number,
) {
  return current
    .filter((day) => day.working && day.free - hoursPerDay < 0)
    .map((day) => ({ day: day.day, free: day.free }));
}
