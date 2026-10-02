/**
 * CD-213 ติดตามงานพัฒนาและข้อบกพร่อง — the rules, apart from the database:
 * a defect's own problems, the moves it may make, and which test items and
 * defects belong to a SOW line.
 */

export const DEFECT_SEVERITIES = ['blocker', 'major', 'minor'] as const;
export const DEFECT_ACTIONS = ['fix', 'verify', 'reopen', 'cancel'] as const;
export type DefectAction = (typeof DEFECT_ACTIONS)[number];
export const MAX_DEFECT_TEXT = 4000;
/** Statuses that still hold the SOW line's work open. */
export const OPEN_DEFECT = ['open', 'fixed'] as const;

/**
 * Whether a test item (CD-221) proves a SOW line: the same scope line or
 * change, or any criterion of the same deliverable.
 */
export function proves(sourceRef: string | null, sowRef: string) {
  if (!sourceRef) return false;
  return (
    sourceRef === sowRef ||
    (sowRef.startsWith('deliverable:') && sourceRef.startsWith(`${sowRef}:`))
  );
}

/** A defect's own problems as it is written, in Thai. */
export function defectProblems(input: {
  title: string;
  severity: string;
  sowRef: string;
  knownRefs: readonly string[];
  foundOn: string | null;
  today: string;
}): string[] {
  const problems: string[] = [];
  if (!input.title.trim()) problems.push('ต้องระบุข้อบกพร่อง');
  if (input.title.length > 255) problems.push('ข้อบกพร่องยาวเกิน 255 ตัวอักษร');
  if (!(DEFECT_SEVERITIES as readonly string[]).includes(input.severity)) {
    problems.push(
      'ระดับความรุนแรงต้องเป็น ปิดกั้นการใช้งาน สำคัญ หรือเล็กน้อย',
    );
  }
  if (!input.sowRef) problems.push('ต้องผูกกับข้อ SOW');
  else if (!input.knownRefs.includes(input.sowRef)) {
    problems.push('ไม่พบข้อ SOW นี้ในโครงการ');
  }
  if (!input.foundOn) problems.push('ต้องระบุวันที่พบ');
  else if (input.foundOn > input.today) {
    problems.push('วันที่พบต้องไม่เกินวันนี้');
  }
  return problems;
}

const FROM: Record<DefectAction, readonly string[]> = {
  fix: ['open'],
  verify: ['fixed'],
  reopen: ['fixed'],
  cancel: ['open', 'fixed'],
};
const TO: Record<DefectAction, string> = {
  fix: 'fixed',
  verify: 'verified',
  reopen: 'open',
  cancel: 'cancelled',
};

/** What stops a move, in Thai; the status it leads to when there is none. */
export function defectMove(input: {
  action: string;
  status: string;
  note: string;
  /** Cancelling is the manager's. */
  canEdit: boolean;
}): { problems: string[]; to: string | null } {
  const action = input.action as DefectAction;
  if (!(DEFECT_ACTIONS as readonly string[]).includes(action)) {
    return { problems: ['ไม่รู้จักการดำเนินการนี้'], to: null };
  }
  const problems: string[] = [];
  if (!FROM[action].includes(input.status)) {
    problems.push('ทำไม่ได้ในสถานะปัจจุบันของข้อบกพร่องนี้');
  }
  if (!input.note.trim()) {
    problems.push(
      {
        fix: 'ต้องบอกว่าแก้อย่างไร',
        verify: 'ต้องบันทึกผลการทดสอบซ้ำ',
        reopen: 'ต้องบอกว่าทดสอบซ้ำแล้วยังพบอะไร',
        cancel: 'ต้องบอกเหตุผลที่ยกเลิก',
      }[action],
    );
  }
  if (action === 'cancel' && !input.canEdit) {
    problems.push('ยกเลิกได้เฉพาะผู้จัดการโครงการ');
  }
  return { problems, to: problems.length ? null : TO[action] };
}
