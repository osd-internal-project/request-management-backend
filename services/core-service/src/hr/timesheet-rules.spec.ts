import { cleanWeek, mandays, weekDays, weekStartOf } from './timesheet-rules';

const week = '2026-09-28'; // Monday
const today = '2026-10-01'; // Thursday

describe('CD-231 กติกา Timesheet', () => {
  it('สัปดาห์เริ่มวันจันทร์', () => {
    expect(weekStartOf('2026-10-04')).toBe('2026-09-28'); // Sunday
    expect(weekStartOf('2026-09-28')).toBe('2026-09-28');
    expect(weekDays(week)).toHaveLength(7);
    expect(weekDays(week)[6]).toBe('2026-10-04');
  });

  it('งานเดียวกันวันเดียวกันรวมเป็นบรรทัดเดียว; billable ตามชนิดงาน', () => {
    const { lines, problems } = cleanWeek(
      [
        {
          kind: 'project',
          project_id: 'P',
          work_type_id: 'W',
          hours: { '2026-09-28': 3 },
        },
        {
          kind: 'project',
          project_id: 'P',
          work_type_id: 'W',
          hours: { '2026-09-28': 1.5 },
        },
        {
          kind: 'presales',
          solution_id: 'S',
          work_type_id: 'W',
          billable: true,
          hours: { '2026-09-29': 2 },
        },
        {
          kind: 'service',
          request_id: 'R',
          work_type_id: 'W',
          billable: false,
          hours: { '2026-09-29': 1 },
        },
      ],
      week,
      today,
    );
    expect(problems).toEqual([]);
    expect(lines.map((l) => [l.workDate, l.kind, l.hours, l.billable])).toEqual(
      [
        ['2026-09-28', 'project', 4.5, true],
        ['2026-09-29', 'presales', 2, false],
        ['2026-09-29', 'service', 1, false],
      ],
    );
  });

  it('ทีละ 0.5 ชม., อยู่ในสัปดาห์, ไม่ล่วงหน้า, ต้องเลือกงานและประเภทงาน', () => {
    const { problems } = cleanWeek(
      [
        {
          kind: 'project',
          project_id: 'P',
          work_type_id: 'W',
          hours: { '2026-09-28': 1.3 },
        },
        {
          kind: 'project',
          project_id: 'P',
          work_type_id: 'W',
          hours: { '2026-10-05': 1 },
        },
        {
          kind: 'project',
          project_id: 'P',
          work_type_id: 'W',
          hours: { '2026-10-02': 1 },
        },
        { kind: 'internal', work_type_id: 'W', hours: { '2026-09-28': 1 } },
        { kind: 'project', project_id: 'P', hours: { '2026-09-28': 1 } },
        { kind: 'leave', hours: { '2026-09-28': 1 } },
      ],
      week,
      today,
    );
    expect(problems).toHaveLength(6);
  });

  it('เกิน 8 ชม./วัน เตือน; เกิน 24 ชม./วัน ไม่รับ', () => {
    const long = cleanWeek(
      [
        {
          kind: 'project',
          project_id: 'P',
          work_type_id: 'W',
          hours: { '2026-09-28': 10 },
        },
      ],
      week,
      today,
    );
    expect(long.problems).toEqual([]);
    expect(long.warnings[0]).toContain('10');
    const over = cleanWeek(
      [
        {
          kind: 'project',
          project_id: 'P',
          work_type_id: 'W',
          hours: { '2026-09-28': 20 },
        },
        {
          kind: 'internal',
          internal_code: 'MEETING',
          work_type_id: 'W',
          hours: { '2026-09-28': 5 },
        },
      ],
      week,
      today,
    );
    expect(over.problems[0]).toContain('เกิน 24');
  });

  it('manday = ชั่วโมง ÷ 8', () => {
    expect(mandays(12)).toBe(1.5);
  });
});
