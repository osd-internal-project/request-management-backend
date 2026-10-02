/**
 * CD-211 ออกแบบรายละเอียด — the rules, apart from the database: the key
 * configuration values a design fixes, what a version needs before it is
 * sent for approval, and which version is in force.
 */

export const MAX_DESIGN_SETTINGS = 200;
export const MAX_DESIGN_TEXT = 4000;
export const MAX_DESIGN_FILES = 50;

export interface DesignSetting {
  key: string;
  value: string;
}

/** Stored settings, read defensively. */
export function readSettings(value: unknown): DesignSetting[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) => {
    if (!row || typeof row !== 'object') return [];
    const { key, value: v } = row as Record<string, unknown>;
    return typeof key === 'string' && key.trim()
      ? [{ key: key.trim(), value: typeof v === 'string' ? v.trim() : '' }]
      : [];
  });
}

/** Settings as entered: blank keys dropped; a key twice is a problem. */
export function cleanSettings(
  rows: readonly { key?: unknown; value?: unknown }[],
) {
  const settings = readSettings(rows);
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const row of settings) {
    if (seen.has(row.key)) problems.push(`ค่าตั้งค่า "${row.key}" ซ้ำ`);
    seen.add(row.key);
    if (row.key.length > 200 || row.value.length > 1000) {
      problems.push(`ค่าตั้งค่า "${row.key.slice(0, 30)}" ยาวเกินไป`);
    }
  }
  if (settings.length > MAX_DESIGN_SETTINGS) {
    problems.push(`ค่าตั้งค่าได้ไม่เกิน ${MAX_DESIGN_SETTINGS} รายการ`);
  }
  return { settings, problems };
}

/** What a draft needs before it is sent for approval, in Thai. */
export function designSubmitProblems(input: {
  title: string;
  files: number;
  differsFromSolution: boolean;
  differences: string | null;
}): string[] {
  const problems: string[] = [];
  if (!input.title.trim()) problems.push('ต้องระบุชื่อแบบ');
  if (!input.files) problems.push('ต้องแนบไฟล์แบบอย่างน้อย 1 ไฟล์');
  if (input.differsFromSolution && !input.differences?.trim()) {
    problems.push('แบบต่างจาก Solution ที่อนุมัติ: ต้องบอกว่าต่างตรงไหน');
  }
  return problems;
}

/** The newest approved version — the design in force. */
export function designInForce<T extends { versionNo: number; status: string }>(
  versions: readonly T[],
): T | null {
  return (
    [...versions]
      .filter((row) => row.status === 'approved')
      .sort((a, b) => b.versionNo - a.versionNo)[0] ?? null
  );
}

/** Only one version is worked on (draft or with the approvers) at a time. */
export function openVersion<T extends { status: string }>(
  versions: readonly T[],
): T | null {
  return (
    versions.find(
      (row) => row.status === 'draft' || row.status === 'submitted',
    ) ?? null
  );
}
