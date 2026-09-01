import {
  addWorkingMs,
  DEFAULT_CALENDAR,
  workingMsBetween,
  type WorkingCalendar,
} from './business-hours';

const HOUR = 60 * 60 * 1000;

/** Bangkok is UTC+7, so 08:30 local is 01:30Z and 17:30 local is 10:30Z. */
const calendar: WorkingCalendar = DEFAULT_CALENDAR;

/** A wall-clock time in the calendar's zone, as an instant. */
function bangkok(iso: string): Date {
  return new Date(`${iso}+07:00`);
}

/** `YYYY-MM-DDTHH:mm` in the calendar's zone, for readable assertions. */
function asBangkok(at: Date): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Bangkok',
    dateStyle: 'short',
    timeStyle: 'short',
  })
    .format(at)
    .replace(' ', 'T');
}

describe('SUP-01 · H24X7 is elapsed time', () => {
  it('adds the budget straight on, weekend or not', () => {
    // Friday 17:00 + 24h = Saturday 17:00. The behaviour the clock always had,
    // and the reason the other two modes exist.
    const due = addWorkingMs(
      bangkok('2026-08-28T17:00'),
      24 * HOUR,
      calendar,
      'H24X7',
    );

    expect(asBangkok(due)).toBe('2026-08-29T17:00');
  });
});

describe('SUP-01 · H8X7 counts the window every day', () => {
  it('spends only what is left of today, then continues tomorrow', () => {
    // 16:30 Friday leaves one hour before 17:30. Four more come from Saturday,
    // which this coverage counts.
    const due = addWorkingMs(
      bangkok('2026-08-28T16:30'),
      5 * HOUR,
      calendar,
      'H8X7',
    );

    expect(asBangkok(due)).toBe('2026-08-29T12:30');
  });

  it('does not skip the weekend', () => {
    const due = addWorkingMs(
      bangkok('2026-08-28T09:00'),
      18 * HOUR,
      calendar,
      'H8X7',
    );

    // 8.5h Fri + 9h Sat = 17.5h, so the last half hour lands on Sunday.
    expect(asBangkok(due)).toBe('2026-08-30T09:00');
  });
});

describe('SUP-01 · H8X5 counts working days only', () => {
  it('starting before opening waits for the window rather than the clock', () => {
    const due = addWorkingMs(
      bangkok('2026-08-28T06:00'),
      1 * HOUR,
      calendar,
      'H8X5',
    );

    expect(asBangkok(due)).toBe('2026-08-28T09:30');
  });

  it('starting after closing moves to the next working morning', () => {
    const due = addWorkingMs(
      bangkok('2026-08-27T20:00'),
      1 * HOUR,
      calendar,
      'H8X5',
    );

    expect(asBangkok(due)).toBe('2026-08-28T09:30');
  });

  /**
   * The case that started all of this: a Friday-afternoon ticket with a
   * one-day SLA was due on Saturday, when nobody was there to answer it.
   */
  it('carries a Friday budget across the weekend to Monday', () => {
    const due = addWorkingMs(
      bangkok('2026-08-28T16:30'),
      5 * HOUR,
      calendar,
      'H8X5',
    );

    // 1h Friday, then 4h from Monday morning.
    expect(asBangkok(due)).toBe('2026-08-31T12:30');
  });

  it('skips a declared holiday', () => {
    const withHoliday: WorkingCalendar = {
      ...calendar,
      holidays: ['2026-08-31'],
    };

    const due = addWorkingMs(
      bangkok('2026-08-28T16:30'),
      5 * HOUR,
      withHoliday,
      'H8X5',
    );

    expect(asBangkok(due)).toBe('2026-09-01T12:30');
  });

  it('lands exactly at closing time when the budget fits the day', () => {
    const due = addWorkingMs(
      bangkok('2026-08-28T08:30'),
      9 * HOUR,
      calendar,
      'H8X5',
    );

    expect(asBangkok(due)).toBe('2026-08-28T17:30');
  });

  /**
   * A calendar with no working days would walk forward for ever. It falls back
   * to elapsed time instead — late is a wrong answer, never is a hung request.
   */
  it('falls back to elapsed time rather than looping on an empty week', () => {
    const closed: WorkingCalendar = { ...calendar, workingWeekdays: [] };

    const due = addWorkingMs(
      bangkok('2026-08-28T09:00'),
      2 * HOUR,
      closed,
      'H8X5',
    );

    expect(due.getTime()).toBeGreaterThan(
      bangkok('2026-08-28T09:00').getTime(),
    );
  });
});

describe('SUP-01 · pausing counts working time, not wall time', () => {
  it('counts nothing for a pause that spans only a weekend', () => {
    const spent = workingMsBetween(
      bangkok('2026-08-28T18:00'),
      bangkok('2026-08-31T08:00'),
      calendar,
      'H8X5',
    );

    expect(spent).toBe(0);
  });

  it('counts the working part of a mixed span', () => {
    const spent = workingMsBetween(
      bangkok('2026-08-28T16:30'),
      bangkok('2026-08-31T10:30'),
      calendar,
      'H8X5',
    );

    // 1h Friday afternoon + 2h Monday morning.
    expect(spent).toBe(3 * HOUR);
  });

  it('counts every hour under H24X7', () => {
    const spent = workingMsBetween(
      bangkok('2026-08-28T18:00'),
      bangkok('2026-08-29T18:00'),
      calendar,
      'H24X7',
    );

    expect(spent).toBe(24 * HOUR);
  });
});
