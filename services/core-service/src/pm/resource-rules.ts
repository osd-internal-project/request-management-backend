/**
 * CD-180 จัดสรรทรัพยากร — the rules, apart from the database: where a
 * booking runs past what someone has free and whose projects it clashes
 * with, what an overbooking must say, and a team's load by week.
 */
import type { DayAvailability } from '../hr/leave-rules';

export const PRIORITIES = ['this_first', 'others_first'] as const;
export const MAX_RESOURCE_TEXT = 2000;

/** Days the new hours would not fit, and the other projects booked on them. */
export function bookingClash(
  days: readonly DayAvailability[],
  hoursPerDay: number,
  projectId: string,
) {
  const over = days.filter((day) => day.working && day.free - hoursPerDay < 0);
  const projects = [
    ...new Set(
      over.flatMap((day) =>
        day.booked
          .map((booking) => booking.projectId)
          .filter((id) => id !== projectId),
      ),
    ),
  ];
  return {
    overbooked: over.map((day) => ({
      day: day.day,
      free: day.free,
      short: Math.round((hoursPerDay - day.free) * 10) / 10,
      onLeave: day.leaveHours > 0,
    })),
    conflictProjectIds: projects,
  };
}

/** An overbooking must say which project comes first, and why. */
export function priorityProblems(input: {
  overbooked: number;
  priority: string | undefined;
  reason: string;
}): string[] {
  if (!input.overbooked) return [];
  const problems: string[] = [];
  if (!(PRIORITIES as readonly string[]).includes(input.priority ?? '')) {
    problems.push(
      `จองเกินเวลาว่าง ${input.overbooked} วัน — ต้องระบุว่าโครงการไหนมาก่อน`,
    );
  }
  if (!input.reason.trim()) problems.push('ต้องระบุเหตุผลของการจัดลำดับ');
  return problems;
}

/** A request for more people, its own problems. */
export function resourceRequestProblems(input: {
  role: string;
  headcount: number;
  startDate: string;
  endDate: string;
  hoursPerDay: number;
  today: string;
}): string[] {
  const problems: string[] = [];
  if (!input.role.trim()) problems.push('ต้องระบุตำแหน่งหรือทักษะที่ต้องการ');
  if (
    !Number.isInteger(input.headcount) ||
    input.headcount < 1 ||
    input.headcount > 50
  ) {
    problems.push('จำนวนคนต้องเป็น 1–50');
  }
  const day = /^\d{4}-\d{2}-\d{2}$/;
  if (!day.test(input.startDate) || !day.test(input.endDate)) {
    problems.push('ต้องระบุช่วงวันที่');
  } else {
    if (input.endDate < input.startDate) {
      problems.push('วันสิ้นสุดต้องไม่ก่อนวันเริ่ม');
    }
    if (input.endDate < input.today) problems.push('ช่วงที่ขอต้องยังไม่ผ่านไป');
  }
  if (
    !(input.hoursPerDay > 0 && input.hoursPerDay <= 8) ||
    input.hoursPerDay * 2 !== Math.round(input.hoursPerDay * 2)
  ) {
    problems.push('ชั่วโมงต่อวันต้องเป็น 0.5–8 ทีละ 0.5');
  }
  return problems;
}

/** Monday of the ISO week a day falls in. */
export function weekOf(day: string): string {
  const at = Date.parse(`${day}T00:00:00Z`);
  const weekday = new Date(at).getUTCDay() || 7;
  return new Date(at - (weekday - 1) * 86_400_000).toISOString().slice(0, 10);
}

export interface WeekLoad {
  week: string;
  capacity: number;
  leave: number;
  booked: number;
  free: number;
  /** booked as % of what was left after leave; null with nothing left */
  pct: number | null;
  overbookedDays: number;
  projects: { projectId: string; hours: number }[];
}

/** One person's days folded into weeks. */
export function weeklyLoad(days: readonly DayAvailability[]): WeekLoad[] {
  const weeks = new Map<string, WeekLoad>();
  for (const day of days) {
    const key = weekOf(day.day);
    const week = weeks.get(key) ?? {
      week: key,
      capacity: 0,
      leave: 0,
      booked: 0,
      free: 0,
      pct: null,
      overbookedDays: 0,
      projects: [],
    };
    week.capacity += day.capacity;
    week.leave += day.leaveHours;
    week.booked += day.bookedHours;
    week.free += day.free;
    if (day.working && day.free < 0) week.overbookedDays += 1;
    for (const booking of day.booked) {
      const row = week.projects.find((p) => p.projectId === booking.projectId);
      if (row) row.hours += booking.hours;
      else
        week.projects.push({
          projectId: booking.projectId,
          hours: booking.hours,
        });
    }
    weeks.set(key, week);
  }
  return [...weeks.values()]
    .sort((a, b) => a.week.localeCompare(b.week))
    .map((week) => {
      const open = week.capacity - week.leave;
      return {
        ...week,
        pct:
          open > 0
            ? Math.round((week.booked / open) * 100)
            : week.booked > 0
              ? 999
              : null,
      };
    });
}
