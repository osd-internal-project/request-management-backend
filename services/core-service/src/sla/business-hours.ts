import type { SlaCoverage } from '@prisma/client';

/**
 * Working-time arithmetic for the SLA clock (SUP-01, D-09).
 *
 * Until 31 Aug 2026 the clock added `hours × 3_600_000` to the start time and
 * called it a deadline. `RequestType.slaBusinessHours`, `SlaConfig.
 * businessHours` and every field of `HolidayCalendar` were written by the
 * admin screens and read by nothing — a 24-hour SLA raised at 17:00 on a
 * Friday was due at 17:00 on Saturday, which no desk agreed to.
 *
 * Pure on purpose: given a calendar and a starting instant it answers when a
 * budget of working milliseconds runs out, with no database and no clock of
 * its own, so the awkward cases are testable directly.
 *
 * **Everything here works in the calendar's own local day.** The window is
 * stored as minutes from midnight, and a company's working day is a wall-clock
 * fact — `08:30` does not shift because the server runs in UTC. `timeZone`
 * carries that; the arithmetic reads the wall-clock parts of an instant in
 * that zone and never in the server's.
 */
export interface WorkingCalendar {
  /** Minutes from midnight, e.g. 510 = 08:30. */
  readonly workdayStartMinute: number;
  /** Minutes from midnight, e.g. 1050 = 17:30. */
  readonly workdayEndMinute: number;
  /** ISO weekday numbers that are working days (1 = Monday, 7 = Sunday). */
  readonly workingWeekdays: readonly number[];
  /** `YYYY-MM-DD` dates the office is closed. */
  readonly holidays: readonly string[];
  /** IANA zone the window is expressed in, e.g. `Asia/Bangkok`. */
  readonly timeZone: string;
}

export const DEFAULT_CALENDAR: WorkingCalendar = {
  workdayStartMinute: 510,
  workdayEndMinute: 1050,
  workingWeekdays: [1, 2, 3, 4, 5],
  holidays: [],
  timeZone: 'Asia/Bangkok',
};

const MINUTE_MS = 60 * 1000;
const DAY_MINUTES = 24 * 60;

/**
 * A day in the calendar's zone, plus how far into it an instant falls.
 *
 * `Intl` rather than `getUTCDay()` and friends: the office window is a
 * wall-clock fact in one place, and reading it off a UTC instant puts the
 * Bangkok working day seven hours out.
 */
interface LocalParts {
  /** `YYYY-MM-DD` in the calendar's zone. */
  readonly date: string;
  /** ISO weekday, 1 = Monday. */
  readonly weekday: number;
  /** Minutes from local midnight. */
  readonly minuteOfDay: number;
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function localParts(at: Date, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  }).formatToParts(at);

  const value = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? '';

  // `hour12: false` renders midnight as 24 in some runtimes.
  const hour = Number(value('hour')) % 24;

  return {
    date: `${value('year')}-${value('month')}-${value('day')}`,
    weekday: WEEKDAYS.indexOf(value('weekday')) + 1,
    minuteOfDay: hour * 60 + Number(value('minute')),
  };
}

/**
 * The calendar day an instant falls on, where it falls in it, and whether
 * the office is open that day — for schedules keyed to the local day, such as
 * the daily notification digest (CD-52).
 */
export function localDay(
  at: Date,
  calendar: WorkingCalendar,
): { date: string; minuteOfDay: number; workingDay: boolean } {
  const parts = localParts(at, calendar.timeZone);
  return {
    date: parts.date,
    minuteOfDay: parts.minuteOfDay,
    workingDay: isWorkingDay(parts, calendar),
  };
}

function isWorkingDay(parts: LocalParts, calendar: WorkingCalendar): boolean {
  return (
    calendar.workingWeekdays.includes(parts.weekday) &&
    !calendar.holidays.includes(parts.date)
  );
}

/**
 * Whether a day counts at all under this coverage.
 *
 * `H8X7` deliberately ignores weekends and holidays: a desk staffed every day
 * of the year still stops at closing time, and that is the distinction the old
 * boolean could not express.
 */
function dayCounts(
  parts: LocalParts,
  calendar: WorkingCalendar,
  coverage: SlaCoverage,
): boolean {
  return coverage === 'H8X5' ? isWorkingDay(parts, calendar) : true;
}

/**
 * When a budget of working milliseconds, starting at `from`, runs out.
 *
 * `H24X7` is plain elapsed time. The other two walk forward one day at a time,
 * spending only the part of each day that falls inside the working window —
 * starting before it opens waits for the opening, and starting after it closes
 * moves to the next counted day rather than burning the night.
 *
 * A calendar with no counted days at all (every weekday excluded) would loop
 * for ever, so the walk is bounded: it gives up after two years and falls back
 * to elapsed time, which is late rather than never.
 */
export function addWorkingMs(
  from: Date,
  budgetMs: number,
  calendar: WorkingCalendar,
  coverage: SlaCoverage,
): Date {
  if (coverage === 'H24X7') return new Date(from.getTime() + budgetMs);
  if (budgetMs <= 0) return from;

  const windowMinutes = Math.max(
    calendar.workdayEndMinute - calendar.workdayStartMinute,
    0,
  );
  if (windowMinutes === 0) return new Date(from.getTime() + budgetMs);

  let cursor = from;
  let remaining = budgetMs;

  for (let guard = 0; guard < 800; guard += 1) {
    const parts = localParts(cursor, calendar.timeZone);

    if (!dayCounts(parts, calendar, coverage)) {
      cursor = startOfNextDay(cursor, parts, calendar);
      continue;
    }

    // Before opening: the clock has not started for the day yet.
    if (parts.minuteOfDay < calendar.workdayStartMinute) {
      cursor = new Date(
        cursor.getTime() +
          (calendar.workdayStartMinute - parts.minuteOfDay) * MINUTE_MS,
      );
      continue;
    }

    // After closing: nothing more is spent today.
    if (parts.minuteOfDay >= calendar.workdayEndMinute) {
      cursor = startOfNextDay(cursor, parts, calendar);
      continue;
    }

    const leftToday =
      (calendar.workdayEndMinute - parts.minuteOfDay) * MINUTE_MS;

    if (remaining <= leftToday) return new Date(cursor.getTime() + remaining);

    remaining -= leftToday;
    cursor = new Date(cursor.getTime() + leftToday);
  }

  return new Date(cursor.getTime() + remaining);
}

/** The opening minute of the day after `parts`, as an instant. */
function startOfNextDay(
  cursor: Date,
  parts: LocalParts,
  calendar: WorkingCalendar,
): Date {
  const toMidnight = DAY_MINUTES - parts.minuteOfDay;

  return new Date(
    cursor.getTime() + (toMidnight + calendar.workdayStartMinute) * MINUTE_MS,
  );
}

/**
 * How much *working* time passed between two instants.
 *
 * The counterpart of {@link addWorkingMs}, used when the clock pauses: a
 * request that sat with its requester over a weekend should not have that
 * weekend deducted from the receiving team's budget.
 */
export function workingMsBetween(
  from: Date,
  to: Date,
  calendar: WorkingCalendar,
  coverage: SlaCoverage,
): number {
  if (coverage === 'H24X7') return Math.max(to.getTime() - from.getTime(), 0);
  if (to <= from) return 0;

  let cursor = from;
  let counted = 0;

  for (let guard = 0; guard < 800 && cursor < to; guard += 1) {
    const parts = localParts(cursor, calendar.timeZone);

    if (!dayCounts(parts, calendar, coverage)) {
      cursor = startOfNextDay(cursor, parts, calendar);
      continue;
    }

    if (parts.minuteOfDay < calendar.workdayStartMinute) {
      cursor = new Date(
        cursor.getTime() +
          (calendar.workdayStartMinute - parts.minuteOfDay) * MINUTE_MS,
      );
      continue;
    }

    if (parts.minuteOfDay >= calendar.workdayEndMinute) {
      cursor = startOfNextDay(cursor, parts, calendar);
      continue;
    }

    const endOfWindow = new Date(
      cursor.getTime() +
        (calendar.workdayEndMinute - parts.minuteOfDay) * MINUTE_MS,
    );
    const until = endOfWindow < to ? endOfWindow : to;

    counted += until.getTime() - cursor.getTime();
    cursor = until === to ? to : startOfNextDay(until, parts, calendar);
  }

  return counted;
}
