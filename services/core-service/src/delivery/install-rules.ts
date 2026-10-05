/**
 * CD-254 ยืนยันงานติดตั้งเสร็จ — the gate, apart from the database: the
 * technicians' readiness check (CD-225) must pass — every checklist line
 * passed and every system check ok — except the delivery documents (the
 * delivery team's work after installation, CD-251) and the confirmation
 * itself.
 */

/** Checks that do not hold back the confirmation. */
export const NOT_INSTALL_GATES = ['delivery_docs', 'install_confirmed'];

export interface ReadinessState {
  checks: { key: string; label: string; ok: boolean; detail: string | null }[];
  readiness: {
    total: number;
    passed: number;
    failed: number;
    unchecked: number;
  };
}

/** What still stands in the way, in Thai; empty = may confirm. */
export function installBlockers(state: ReadinessState): string[] {
  const blockers: string[] = [];
  if (!state.readiness.total) {
    blockers.push('ทีมช่างยังไม่ได้เริ่มตรวจความพร้อมก่อนส่งมอบ');
  } else if (state.readiness.passed < state.readiness.total) {
    blockers.push(
      `รายการตรวจความพร้อมผ่าน ${state.readiness.passed}/${state.readiness.total}` +
        (state.readiness.failed ? ` (ไม่ผ่าน ${state.readiness.failed})` : ''),
    );
  }
  for (const check of state.checks) {
    if (check.ok || NOT_INSTALL_GATES.includes(check.key)) continue;
    blockers.push(
      check.detail ? `${check.label}: ${check.detail}` : check.label,
    );
  }
  return blockers;
}
