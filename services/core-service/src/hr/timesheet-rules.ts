/**
 * CD-231 — the rules of a weekly timesheet, pure. Dates are YYYY-MM-DD
 * (business days, Thai time); a week starts on Monday.
 */

export const WORK_KINDS = [
  'project',
  'service',
  'presales',
  'internal',
] as const;
export type WorkKind = (typeof WORK_KINDS)[number];

/** Hours past which a day is flagged (never refused). */
export const LONG_DAY_HOURS = 8;
/** One manday. */
export const HOURS_PER_MANDAY = 8;

const MS_DAY = 86_400_000;
const at = (day: string) => Date.parse(`${day}T00:00:00Z`);
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The Monday of the week `day` falls in. */
export function weekStartOf(day: string): string {
  const weekday = new Date(at(day)).getUTCDay(); // 0 = Sunday
  return iso(at(day) - ((weekday + 6) % 7) * MS_DAY);
}

export function weekDays(weekStart: string): string[] {
  return Array.from({ length: 7 }, (_, index) =>
    iso(at(weekStart) + index * MS_DAY),
  );
}

export interface RowInput {
  kind?: string;
  project_id?: string | null;
  project_task_id?: string | null;
  request_id?: string | null;
  solution_id?: string | null;
  internal_code?: string | null;
  work_type_id?: string;
  billable?: boolean;
  note?: string;
  /** date → hours */
  hours?: Record<string, number>;
}

export interface CleanLine {
  workDate: string;
  kind: WorkKind;
  projectId: string | null;
  projectTaskId: string | null;
  requestId: string | null;
  solutionId: string | null;
  internalCode: string | null;
  workTypeId: string;
  hours: number;
  billable: boolean;
  note: string;
}

/** What one line is about — lines with the same subject on a day merge. */
export function subjectKey(
  line: Omit<CleanLine, 'workDate' | 'hours' | 'note' | 'billable'>,
) {
  return [
    line.kind,
    line.projectId ?? '',
    line.projectTaskId ?? '',
    line.requestId ?? '',
    line.solutionId ?? '',
    line.internalCode ?? '',
    line.workTypeId,
  ].join('|');
}

/**
 * The week's rows as lines: each needs a kind, the thing it is about and a
 * work type; hours in steps of 0.5, within the week and not ahead of today;
 * the same work on the same day is one line; a day holds at most 24 hours.
 * Project and service time is billable unless said otherwise; Pre-Sales and
 * internal time never is. Long days are warned, not refused.
 */
export function cleanWeek(
  rows: readonly RowInput[],
  weekStart: string,
  today: string,
): { lines: CleanLine[]; problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const days = new Set(weekDays(weekStart));
  const merged = new Map<string, CleanLine>();

  rows.forEach((row, index) => {
    const where = `แถว ${index + 1}`;
    const kind = row.kind as WorkKind;
    if (!WORK_KINDS.includes(kind)) {
      problems.push(`${where}: ประเภทงานที่ลงเวลาไม่ถูกต้อง`);
      return;
    }
    const subject = {
      kind,
      projectId: kind === 'project' ? (row.project_id ?? null) : null,
      projectTaskId: kind === 'project' ? (row.project_task_id ?? null) : null,
      requestId: kind === 'service' ? (row.request_id ?? null) : null,
      solutionId: kind === 'presales' ? (row.solution_id ?? null) : null,
      internalCode: kind === 'internal' ? (row.internal_code ?? null) : null,
      workTypeId: row.work_type_id ?? '',
    };
    const missing =
      (kind === 'project' && !subject.projectId) ||
      (kind === 'service' && !subject.requestId) ||
      (kind === 'presales' && !subject.solutionId) ||
      (kind === 'internal' && !subject.internalCode);
    if (missing) {
      problems.push(`${where}: ต้องเลือกงานที่ลงเวลา`);
      return;
    }
    if (!subject.workTypeId) {
      problems.push(`${where}: ต้องเลือกประเภทงาน`);
      return;
    }
    const billable =
      kind === 'project' || kind === 'service' ? (row.billable ?? true) : false;
    for (const [day, raw] of Object.entries(row.hours ?? {})) {
      const hours = Number(raw);
      if (!hours) continue;
      if (!days.has(day)) {
        problems.push(`${where}: วันที่ ${day} ไม่อยู่ในสัปดาห์นี้`);
        continue;
      }
      if (day > today) {
        problems.push(`${where}: ลงเวลาล่วงหน้าไม่ได้ (${day})`);
        continue;
      }
      if (hours < 0 || hours > 24 || Math.round(hours * 2) !== hours * 2) {
        problems.push(
          `${where}: ชั่วโมงต้องเป็นทีละ 0.5 ระหว่าง 0–24 (${day})`,
        );
        continue;
      }
      const key = `${day}|${subjectKey(subject)}`;
      const found = merged.get(key);
      if (found) {
        found.hours += hours;
        found.billable = found.billable && billable;
        if (row.note?.trim()) {
          found.note = [found.note, row.note.trim()]
            .filter(Boolean)
            .join(' · ');
        }
      } else {
        merged.set(key, {
          ...subject,
          workDate: day,
          hours,
          billable,
          note: row.note?.trim() ?? '',
        });
      }
    }
  });

  const lines = [...merged.values()].sort((a, b) =>
    a.workDate.localeCompare(b.workDate),
  );
  const perDay = dayTotals(lines);
  const warnings: string[] = [];
  for (const [day, total] of Object.entries(perDay)) {
    if (total > 24)
      problems.push(`วันที่ ${day} รวม ${total} ชม. เกิน 24 ชั่วโมง`);
    else if (total > LONG_DAY_HOURS)
      warnings.push(`วันที่ ${day} รวม ${total} ชม. (เกิน ${LONG_DAY_HOURS})`);
  }
  return { lines, problems: [...new Set(problems)], warnings };
}

export function dayTotals(
  lines: readonly { workDate: string; hours: number }[],
): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const line of lines) {
    totals[line.workDate] = (totals[line.workDate] ?? 0) + line.hours;
  }
  return totals;
}

export function mandays(hours: number): number {
  return Math.round((hours / HOURS_PER_MANDAY) * 100) / 100;
}
