/**
 * CD-222 สนับสนุน UAT — the rules, apart from the database: a finding's own
 * problems, the moves it may make, and what blocks acceptance.
 */

export const UAT_SEVERITIES = ['blocker', 'major', 'minor'] as const;
export type UatSeverity = (typeof UAT_SEVERITIES)[number];
export const UAT_ACTIONS = [
  'fix',
  'confirm',
  'reopen',
  'defer',
  'undefer',
] as const;
export type UatAction = (typeof UAT_ACTIONS)[number];
export const MAX_UAT_TEXT = 4000;

/** A finding's own problems as it is written, in Thai. */
export function findingProblems(input: {
  title: string;
  severity: string;
  reportedOn: string | null;
  today: string;
}): string[] {
  const problems: string[] = [];
  if (!input.title.trim()) problems.push('ต้องระบุประเด็น');
  if (input.title.length > 255) problems.push('ประเด็นยาวเกิน 255 ตัวอักษร');
  if (!(UAT_SEVERITIES as readonly string[]).includes(input.severity)) {
    problems.push(
      'ระดับความรุนแรงต้องเป็น ปิดกั้นการใช้งาน สำคัญ หรือเล็กน้อย',
    );
  }
  if (!input.reportedOn) problems.push('ต้องระบุวันที่ลูกค้าแจ้ง');
  else if (input.reportedOn > input.today) {
    problems.push('วันที่แจ้งต้องไม่เกินวันนี้');
  }
  return problems;
}

/** From which status each move may be made. */
const FROM: Record<UatAction, readonly string[]> = {
  fix: ['open'],
  confirm: ['fixed'],
  reopen: ['fixed'],
  defer: ['open', 'fixed'],
  undefer: ['deferred'],
};
const TO: Record<UatAction, string> = {
  fix: 'fixed',
  confirm: 'confirmed',
  reopen: 'open',
  defer: 'deferred',
  undefer: 'open',
};

/** What stops a move, in Thai; the status it leads to when there is none. */
export function moveProblems(input: {
  action: string;
  status: string;
  severity: string;
  note: string;
  confirmedBy: string;
  confirmedOn: string | null;
  today: string;
  /** Defer and undefer are the manager's. */
  canEdit: boolean;
}): { problems: string[]; to: string | null } {
  const action = input.action as UatAction;
  if (!(UAT_ACTIONS as readonly string[]).includes(action)) {
    return { problems: ['ไม่รู้จักการดำเนินการนี้'], to: null };
  }
  const problems: string[] = [];
  if (!FROM[action].includes(input.status)) {
    problems.push('ทำไม่ได้ในสถานะปัจจุบันของประเด็นนี้');
  }
  if (action === 'fix' && !input.note.trim()) {
    problems.push('ต้องบอกว่าแก้อย่างไร');
  }
  if (action === 'confirm') {
    if (!input.confirmedBy.trim()) problems.push('ต้องระบุผู้ยืนยันฝั่งลูกค้า');
    if (!input.confirmedOn) problems.push('ต้องระบุวันที่ลูกค้ายืนยัน');
    else if (input.confirmedOn > input.today) {
      problems.push('วันที่ยืนยันต้องไม่เกินวันนี้');
    }
  }
  if (action === 'reopen' && !input.note.trim()) {
    problems.push('ต้องบอกว่าลูกค้ายังไม่ยอมรับเพราะอะไร');
  }
  if (action === 'defer') {
    if (input.severity === 'blocker') {
      problems.push(
        'ประเด็นที่ปิดกั้นการใช้งานต้องแก้ก่อนตรวจรับ เลื่อนไม่ได้',
      );
    }
    if (!input.note.trim()) problems.push('ต้องระบุเหตุผลที่เลื่อน');
  }
  if ((action === 'defer' || action === 'undefer') && !input.canEdit) {
    problems.push('เลื่อนหรือนำกลับได้เฉพาะผู้จัดการโครงการ');
  }
  return { problems, to: problems.length ? null : TO[action] };
}

/** Where the register stands — and what blocks acceptance. */
export function uatState(
  findings: readonly { label: string; severity: string; status: string }[],
) {
  const blocking = findings.filter(
    (row) => row.severity === 'blocker' && row.status !== 'confirmed',
  );
  return {
    total: findings.length,
    open: findings.filter((row) => row.status === 'open').length,
    fixed: findings.filter((row) => row.status === 'fixed').length,
    confirmed: findings.filter((row) => row.status === 'confirmed').length,
    deferred: findings.filter((row) => row.status === 'deferred').length,
    blocking: blocking.map((row) => row.label),
  };
}
