/**
 * CD-226 เอกสารสภาพจริง (As-built) — the rules, apart from the database:
 * what in the baseline a deviation can point at, a deviation's own
 * problems, and when the as-built is complete.
 */
import { readBoq, readLines } from '../presales/solution-rules';

export const DEFAULT_AS_BUILT_DOCUMENTS = [
  'แบบติดตั้งจริง',
  'รายการอุปกรณ์และหมายเลขเครื่อง',
  'ผังการเชื่อมต่อระบบ',
];
export const MAX_DEVIATION_TEXT = 2000;
export const MAX_AS_BUILT_DOCUMENTS = 100;

/** The lines of what was sold a deviation may point at. */
export function asBuiltRefs(
  baseline: unknown,
): { ref: string; label: string }[] {
  const base = baseline as {
    boq?: unknown;
    scope?: { inScope?: unknown };
  } | null;
  return [
    ...readBoq(base?.boq).map((line, index) => ({
      ref: `boq:${index}`,
      label: `BOQ ${index + 1}: ${line.name || line.productCode} × ${line.quantity}${line.unit ? ` ${line.unit}` : ''}`,
    })),
    ...readLines(base?.scope?.inScope).map((line, index) => ({
      ref: `scope:${index}`,
      label: `ขอบเขต ${index + 1}: ${line}`,
    })),
  ];
}

/** A deviation's own problems as it is written, in Thai. */
export function deviationProblems(input: {
  planned: string;
  built: string;
  reference: string | null;
  refs: readonly string[];
}): string[] {
  const problems: string[] = [];
  if (!input.planned.trim()) problems.push('ต้องระบุสิ่งที่ขาย/ตามแบบ');
  if (!input.built.trim()) problems.push('ต้องระบุสิ่งที่ทำจริง');
  for (const text of [input.planned, input.built]) {
    if (text.length > MAX_DEVIATION_TEXT) {
      problems.push(`ข้อความยาวเกิน ${MAX_DEVIATION_TEXT} ตัวอักษร`);
    }
  }
  if (input.reference && !input.refs.includes(input.reference)) {
    problems.push('รายการที่อ้างอิงไม่อยู่ในฐานตั้งต้นของโครงการ');
  }
  return problems;
}

export interface AsBuiltStatus {
  complete: boolean;
  missingDocuments: string[];
  /** What keeps the deviations from being settled, in Thai. */
  openDeviations: string[];
}

export function asBuiltStatus(input: {
  required: readonly string[];
  uploaded: readonly string[];
  deviations: readonly {
    label: string;
    reason: string | null;
    affectsScope: boolean;
    /** The linked change request's status, if any. */
    changeStatus: string | null;
  }[];
}): AsBuiltStatus {
  const have = new Set(input.uploaded.map((title) => title.trim()));
  const missingDocuments = input.required.filter(
    (title) => !have.has(title.trim()),
  );
  const openDeviations = input.deviations.flatMap((row) => {
    const problems: string[] = [];
    if (!row.reason?.trim()) problems.push(`${row.label}: ยังไม่มีเหตุผล`);
    if (row.affectsScope && row.changeStatus !== 'approved') {
      problems.push(
        `${row.label}: กระทบขอบเขต ต้องผูกกับคำขอเปลี่ยนแปลงที่อนุมัติแล้ว`,
      );
    }
    return problems;
  });
  return {
    complete: !missingDocuments.length && !openDeviations.length,
    missingDocuments,
    openDeviations,
  };
}
