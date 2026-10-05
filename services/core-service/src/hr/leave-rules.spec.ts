import {
  availabilityDays,
  daysByYear,
  leaveProblems,
  leaveShares,
  leavesClash,
  overbookedDays,
  type WorkDays,
} from './leave-rules';

// 2026-10-05 is a Monday; 2026-10-13 a company holiday.
const calendar: WorkDays = {
  workingWeekdays: [1, 2, 3, 4, 5],
  holidays: ['2026-10-13'],
};

describe('CD-232 leave rules', () => {
  it('นับเฉพาะวันทำการ ไม่นับเสาร์-อาทิตย์และวันหยุดบริษัท', () => {
    const shares = leaveShares('2026-10-09', '2026-10-14', 'full', calendar);
    expect(shares.map((s) => s.day)).toEqual([
      '2026-10-09',
      '2026-10-12',
      '2026-10-14',
    ]);
    expect(leaveShares('2026-10-06', '2026-10-06', 'am', calendar)).toEqual([
      { day: '2026-10-06', share: 0.5 },
    ]);
  });

  it('ตรวจคำขอลา', () => {
    expect(leaveProblems('2026-10-06', '2026-10-05', 'full', calendar)).toEqual(
      ['วันสิ้นสุดต้องไม่ก่อนวันเริ่ม'],
    );
    expect(leaveProblems('2026-10-06', '2026-10-07', 'am', calendar)).toEqual([
      'ลาครึ่งวันได้ทีละหนึ่งวัน',
    ]);
    expect(leaveProblems('2026-10-10', '2026-10-11', 'full', calendar)).toEqual(
      ['ช่วงที่ลาไม่มีวันทำการ'],
    );
    expect(leaveProblems('2026-02-30', '2026-03-01', 'full', calendar)).toEqual(
      ['วันที่ไม่ถูกต้อง'],
    );
    expect(leaveProblems('2026-10-06', '2026-10-06', 'pm', calendar)).toEqual(
      [],
    );
  });

  it('เช้า + บ่ายวันเดียวกันไม่ชน; เต็มวันชนทุกแบบ', () => {
    const am = { startDate: '2026-10-06', endDate: '2026-10-06', part: 'am' };
    const pm = { ...am, part: 'pm' };
    const week = {
      startDate: '2026-10-05',
      endDate: '2026-10-09',
      part: 'full',
    };
    expect(leavesClash(am, pm)).toBe(false);
    expect(leavesClash(am, am)).toBe(true);
    expect(leavesClash(week, pm)).toBe(true);
    expect(
      leavesClash(week, {
        ...week,
        startDate: '2026-10-12',
        endDate: '2026-10-12',
      }),
    ).toBe(false);
  });

  it('ลาข้ามปีแยกนับตามปี', () => {
    const byYear = daysByYear(
      { startDate: '2026-12-30', endDate: '2027-01-05', part: 'full' },
      { workingWeekdays: [1, 2, 3, 4, 5], holidays: ['2027-01-01'] },
    );
    expect([...byYear]).toEqual([
      [2026, 2],
      [2027, 2],
    ]);
  });

  it('ความพร้อม = 8 − ลา − จอง; จองเกินบอกวัน', () => {
    const days = availabilityDays(
      ['2026-10-05', '2026-10-06', '2026-10-10'],
      calendar,
      [
        {
          id: 'L',
          startDate: '2026-10-06',
          endDate: '2026-10-06',
          part: 'am',
          status: 'pending',
          typeName: null,
        },
      ],
      [
        {
          id: 'B',
          projectId: 'P',
          startDate: '2026-10-01',
          endDate: '2026-10-31',
          hoursPerDay: 4,
        },
      ],
    );
    expect(
      days.map((d) => [d.capacity, d.leaveHours, d.bookedHours, d.free]),
    ).toEqual([
      [8, 0, 4, 4],
      [8, 4, 4, 0],
      [0, 0, 0, 0],
    ]);
    expect(days[1].pendingLeave).toBe(true);
    expect(overbookedDays(days, 2)).toEqual([{ day: '2026-10-06', free: 0 }]);
    // A holiday inside a leave is just a holiday.
    const [holiday] = availabilityDays(
      ['2026-10-13'],
      calendar,
      [
        {
          id: 'L',
          startDate: '2026-10-12',
          endDate: '2026-10-14',
          part: 'full',
          status: 'approved',
          typeName: 'ลาพักร้อน',
        },
      ],
      [],
    );
    expect(holiday).toMatchObject({ working: false, leaveType: null, free: 0 });
  });
});
