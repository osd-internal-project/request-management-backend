/**
 * CD-218 นำไปใช้งาน — a plan task's status follows its evidence: the
 * installation points (CD-216) and test items (CD-221) linked to it. When
 * every point is installed and every test passed (or waived), the task is
 * done, and the project's progress (CD-188) moves with it; when the
 * evidence stops holding (a point removed, a test failing), it is reopened.
 */

export interface TaskEvidence {
  installs: readonly { installed: boolean }[];
  tests: readonly { state: string }[];
}

export function evidenceOf(evidence: TaskEvidence) {
  const linked = evidence.installs.length + evidence.tests.length;
  const missing =
    evidence.installs.filter((row) => !row.installed).length +
    evidence.tests.filter(
      (row) => row.state !== 'passed' && row.state !== 'waived',
    ).length;
  return { linked, missing, complete: linked > 0 && missing === 0 };
}

/** Where the evidence moves the task, if anywhere. */
export function evidenceMove(
  status: string,
  evidence: TaskEvidence,
): 'done' | 'in_progress' | null {
  const state = evidenceOf(evidence);
  if (!state.linked || status === 'cancelled') return null;
  if (state.complete && status !== 'done') return 'done';
  if (!state.complete && status === 'done') return 'in_progress';
  return null;
}

/** The note a task's history keeps for an automatic move, in Thai. */
export function evidenceNote(
  to: 'done' | 'in_progress',
  evidence: TaskEvidence,
): string {
  const state = evidenceOf(evidence);
  return to === 'done'
    ? `ปิดอัตโนมัติ — หลักฐานครบ ${state.linked} รายการ (จุดติดตั้ง ${evidence.installs.length} · ข้อทดสอบ ${evidence.tests.length})`
    : `เปิดใหม่อัตโนมัติ — หลักฐานยังไม่ครบ ${state.missing} จาก ${state.linked} รายการ`;
}
