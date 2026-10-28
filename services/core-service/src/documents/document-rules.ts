/**
 * Company documents (settings) — the two kinds, what files they take, and
 * the issue date a dated document must carry. Pure.
 */

/** dated = มีวันที่ออกเอกสาร (บังคับกรอก) · general = เอกสารทั่วไป */
export const DOCUMENT_KINDS = ['dated', 'general'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/** PDF, pictures, Office files and zip bundles. */
export const DOCUMENT_FILE_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/zip',
] as const;
export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;

/** Shown in the browser; anything else downloads. */
export function inlineSafe(mimeType: string): boolean {
  return ['image/png', 'image/jpeg', 'application/pdf'].includes(mimeType);
}

export function fileProblems(file: {
  mimetype: string;
  size: number;
}): string[] {
  const problems: string[] = [];
  if (!(DOCUMENT_FILE_TYPES as readonly string[]).includes(file.mimetype)) {
    problems.push(
      'รองรับ PDF รูป (PNG/JPG) ไฟล์ Office (Word/Excel/PowerPoint) และ ZIP',
    );
  }
  if (file.size > MAX_DOCUMENT_BYTES) problems.push('ไฟล์ใหญ่เกิน 50 MB');
  return problems;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The issue date to store for a document of `kind`: a dated document must
 * have a real calendar day; a general one must have none. Returns the day
 * as a UTC-midnight `Date` (the column is `DATE`), `null` for general, or
 * the reason it is refused.
 */
export function issueDateFor(
  kind: DocumentKind,
  value: string | null | undefined,
): { ok: true; date: Date | null } | { ok: false; reason: string } {
  const text = value?.trim() ?? '';
  if (kind === 'general') {
    return text
      ? { ok: false, reason: 'เอกสารทั่วไปไม่มีวันที่ออกเอกสาร' }
      : { ok: true, date: null };
  }
  if (!text) return { ok: false, reason: 'กรอกวันที่ออกเอกสาร' };
  const day = text.slice(0, 10);
  if (!ISO_DAY.test(day)) {
    return { ok: false, reason: 'วันที่ออกเอกสารต้องเป็นรูปแบบ YYYY-MM-DD' };
  }
  const date = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== day) {
    return { ok: false, reason: 'วันที่ออกเอกสารไม่ถูกต้อง' };
  }
  return { ok: true, date };
}

/** `DATE` column → `YYYY-MM-DD`, the form every API answers with. */
export function isoDay(date: Date | null): string | null {
  return date ? date.toISOString().slice(0, 10) : null;
}
