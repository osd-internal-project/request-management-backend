import type { DayAvailability } from '../hr/leave-rules';
import {
  bookingClash,
  priorityProblems,
  resourceRequestProblems,
  weeklyLoad,
  weekOf,
} from './resource-rules';

const day = (
  date: string,
  booked: { projectId: string; hours: number }[],
  leaveHours = 0,
  working = true,
): DayAvailability => {
  const capacity = working ? 8 : 0;
  const bookedHours = booked.reduce((sum, b) => sum + b.hours, 0);
  return {
    day: date,
    working,
    capacity,
    leaveHours,
    pendingLeave: false,
    leaveType: null,
    booked: booked.map((b, i) => ({ bookingId: `b${i}`, ...b })),
    bookedHours,
    free: capacity - leaveHours - bookedHours,
  };
};

describe('CD-180 resource rules', () => {
  const days = [
    day('2026-10-05', [{ projectId: 'P1', hours: 4 }]),
    day('2026-10-06', [
      { projectId: 'P1', hours: 4 },
      { projectId: 'P2', hours: 4 },
    ]),
    day('2026-10-07', [], 8),
    day('2026-10-10', [], 0, false),
  ];

  it('finds the days that do not fit and the projects booked on them', () => {
    expect(bookingClash(days, 4, 'P9')).toEqual({
      overbooked: [
        { day: '2026-10-06', free: 0, short: 4, onLeave: false },
        { day: '2026-10-07', free: 0, short: 4, onLeave: true },
      ],
      conflictProjectIds: ['P1', 'P2'],
    });
    // its own project does not count as a clash
    expect(bookingClash(days, 4, 'P1').conflictProjectIds).toEqual(['P2']);
    expect(bookingClash(days, 4, 'P9').overbooked).toHaveLength(2);
    expect(bookingClash([days[0]], 4, 'P9').overbooked).toEqual([]);
  });

  it('an overbooking says which project comes first, and why', () => {
    expect(
      priorityProblems({ overbooked: 0, priority: undefined, reason: '' }),
    ).toEqual([]);
    expect(
      priorityProblems({ overbooked: 2, priority: 'x', reason: ' ' }),
    ).toHaveLength(2);
    expect(
      priorityProblems({
        overbooked: 2,
        priority: 'this_first',
        reason: 'ลูกค้าเร่งเปิดระบบ',
      }),
    ).toEqual([]);
  });

  it('a request for more people names who, how many and when', () => {
    const ok = {
      role: 'วิศวกรเครือข่าย',
      headcount: 2,
      startDate: '2026-10-12',
      endDate: '2026-10-30',
      hoursPerDay: 8,
      today: '2026-10-05',
    };
    expect(resourceRequestProblems(ok)).toEqual([]);
    expect(
      resourceRequestProblems({
        ...ok,
        role: '',
        headcount: 0,
        endDate: '2026-10-01',
        hoursPerDay: 9,
      }),
    ).toHaveLength(5);
  });

  it('days fold into ISO weeks, with load and the projects behind it', () => {
    expect(weekOf('2026-10-11')).toBe('2026-10-05');
    const [week] = weeklyLoad(days);
    expect(week).toMatchObject({
      week: '2026-10-05',
      capacity: 24,
      leave: 8,
      booked: 12,
      pct: 75,
      overbookedDays: 0,
      projects: [
        { projectId: 'P1', hours: 8 },
        { projectId: 'P2', hours: 4 },
      ],
    });
  });
});
