/**
 * CD-273 — the brand library's rules: categories, what files it takes, and
 * which version anyone sees. Pure.
 */

export const BRAND_CATEGORIES = [
  'logo',
  'proposal_template',
  'presentation',
  'guideline',
  'graphic',
  'other',
] as const;
export type BrandCategory = (typeof BRAND_CATEGORIES)[number];

/** Pictures, PDF, Office files, design sources and zip bundles. */
export const BRAND_FILE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/svg+xml',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/postscript',
  'application/illustrator',
  'application/zip',
] as const;
export const MAX_BRAND_FILE_BYTES = 50 * 1024 * 1024;

/** Shown in the browser; anything else (SVG included — it can carry script) downloads. */
export function inlineSafe(mimeType: string): boolean {
  return ['image/png', 'image/jpeg', 'application/pdf'].includes(mimeType);
}

export function nextVersionNo(existing: readonly number[]): number {
  return existing.length ? Math.max(...existing) + 1 : 1;
}

export function fileProblems(file: {
  mimetype: string;
  size: number;
}): string[] {
  const problems: string[] = [];
  if (!(BRAND_FILE_TYPES as readonly string[]).includes(file.mimetype)) {
    problems.push(
      'รองรับรูป (PNG/JPG/SVG) PDF ไฟล์ Office (PPTX/DOCX/XLSX) AI/EPS และ ZIP',
    );
  }
  if (file.size > MAX_BRAND_FILE_BYTES) problems.push('ไฟล์ใหญ่เกิน 50 MB');
  return problems;
}

/**
 * Which versions a viewer may open: everyone the current one; MACOM every
 * version (history, and those waiting for approval).
 */
export function mayOpenVersion(input: {
  versionId: string;
  currentVersionId: string | null;
  manager: boolean;
}): boolean {
  return input.manager || input.versionId === input.currentVersionId;
}
