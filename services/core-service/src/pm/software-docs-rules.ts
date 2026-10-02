/**
 * CD-215 เอกสารซอฟต์แวร์ — the rules, apart from the database: which
 * version the documents must describe, and when they are complete.
 */

export const DEFAULT_SOFTWARE_DOCUMENTS = [
  'ข้อกำหนดซอฟต์แวร์',
  'คู่มือผู้ใช้',
  'คู่มือผู้ดูแลระบบ',
  'เอกสารจุดเชื่อมต่อ (API)',
];
export const MAX_SOFTWARE_DOCUMENTS = 200;

export interface TargetRelease {
  id: string;
  version: string;
  /** production = what runs there; latest = no production yet, the newest */
  basis: 'production' | 'latest';
}

/**
 * The version the documents must describe: what runs on production; with no
 * production environment, the newest release. A production environment with
 * nothing on it yet has no target — the software is not delivered.
 */
export function targetRelease(input: {
  hasProduction: boolean;
  production: { id: string; version: string } | null;
  latest: { id: string; version: string } | null;
}): TargetRelease | null {
  if (input.hasProduction) {
    return input.production
      ? { ...input.production, basis: 'production' }
      : null;
  }
  return input.latest ? { ...input.latest, basis: 'latest' } : null;
}

export interface SoftwareDocsStatus {
  complete: boolean;
  target: TargetRelease | null;
  /** required titles with no file for the target version */
  missing: string[];
}

export function softwareDocsStatus(input: {
  required: readonly string[];
  target: TargetRelease | null;
  /** live documents: their title and release */
  documents: readonly { title: string; releaseId: string }[];
}): SoftwareDocsStatus {
  const required = [
    ...new Set(input.required.map((title) => title.trim()).filter(Boolean)),
  ];
  if (!input.target) {
    return { complete: false, target: null, missing: required };
  }
  const have = new Set(
    input.documents
      .filter((row) => row.releaseId === input.target!.id)
      .map((row) => row.title.trim()),
  );
  const missing = required.filter((title) => !have.has(title));
  return { complete: missing.length === 0, target: input.target, missing };
}
