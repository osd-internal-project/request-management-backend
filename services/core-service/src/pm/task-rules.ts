/**
 * CD-181 งานย่อย — the rules on reporting work, apart from the database:
 * which status a task may move to, what a report must carry, and the
 * actual start and finish a move stamps.
 */

export const WORK_STATUSES = ['open', 'in_progress', 'done'] as const;
export type WorkStatus = (typeof WORK_STATUSES)[number];

export const MAX_NOTE_LENGTH = 4000;
export const MAX_FILES_PER_UPDATE = 10;

/** What stops a report, in Thai. */
export function reportProblems(input: {
  summary: boolean;
  status: string;
  note: string;
  to: string | null;
  files: number;
}): string[] {
  const problems: string[] = [];
  if (input.status === 'cancelled') problems.push('งานนี้ถูกยกเลิกแล้ว');
  if (input.summary) {
    problems.push('งานนี้มีงานย่อย — รายงานที่งานย่อยแทน');
  }
  if (input.to !== null && !WORK_STATUSES.includes(input.to as WorkStatus)) {
    problems.push('สถานะไม่ถูกต้อง');
  }
  if (!input.note.trim() && !input.files && input.to === null) {
    problems.push('ต้องมีบันทึก ไฟล์ หรือการเปลี่ยนสถานะอย่างน้อยหนึ่งอย่าง');
  }
  if (input.note.length > MAX_NOTE_LENGTH) {
    problems.push(`บันทึกยาวได้ไม่เกิน ${MAX_NOTE_LENGTH} ตัวอักษร`);
  }
  if (input.files > MAX_FILES_PER_UPDATE) {
    problems.push(`แนบได้ครั้งละไม่เกิน ${MAX_FILES_PER_UPDATE} ไฟล์`);
  }
  return problems;
}

/**
 * The stamps a status move leaves: starting work records when it started
 * (once); finishing records when and by whom (and the start, if skipped);
 * reopening clears the finish.
 */
export function statusStamps(
  current: { status: string; startedAt: Date | null; doneAt: Date | null },
  to: WorkStatus,
  now: Date,
  actorId: string,
): {
  status: WorkStatus;
  startedAt: Date | null;
  doneAt: Date | null;
  doneBy: string | null;
} | null {
  if (to === current.status) return null;
  if (to === 'open') {
    return { status: 'open', startedAt: null, doneAt: null, doneBy: null };
  }
  if (to === 'in_progress') {
    return {
      status: 'in_progress',
      startedAt: current.startedAt ?? now,
      doneAt: null,
      doneBy: null,
    };
  }
  return {
    status: 'done',
    startedAt: current.startedAt ?? now,
    doneAt: now,
    doneBy: actorId,
  };
}
