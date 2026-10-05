/**
 * CD-245 อะไหล่และการเคลม — the pure part: a claim's steps, what each needs,
 * when it is late, and the reference a spare's goods issue carries in SAP.
 */

export const CLAIM_STATUSES = [
  'pending',
  'sent',
  'replaced',
  'credited',
  'rejected',
  'cancelled',
] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

/** Where a claim may go from each step; the last four end it. */
const NEXT: Record<ClaimStatus, readonly ClaimStatus[]> = {
  pending: ['sent', 'cancelled'],
  sent: ['replaced', 'credited', 'rejected', 'cancelled'],
  replaced: [],
  credited: [],
  rejected: [],
  cancelled: [],
};

export const CLAIM_OPEN: readonly ClaimStatus[] = ['pending', 'sent'];

export interface ClaimStep {
  to: string;
  sentOn?: string | null;
  expectedOn?: string | null;
  resolvedOn?: string | null;
  creditAmount?: number | null;
  outcomeNote?: string | null;
}

const isDay = (value: string | null | undefined) =>
  Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value));

/** Why a claim cannot take this step. */
export function stepProblems(from: string, step: ClaimStep): string[] {
  const problems: string[] = [];
  const next = NEXT[from as ClaimStatus] ?? [];
  if (!next.includes(step.to as ClaimStatus)) {
    return [`เปลี่ยนสถานะเคลมจาก ${from} เป็น ${step.to} ไม่ได้`];
  }
  if (step.to === 'sent') {
    if (!isDay(step.sentOn)) problems.push('ต้องระบุวันที่ส่งเคลม');
    if (step.expectedOn && !isDay(step.expectedOn)) {
      problems.push('วันที่คาดว่าจะได้คืนไม่ถูกต้อง');
    }
    if (
      isDay(step.sentOn) &&
      isDay(step.expectedOn) &&
      step.expectedOn! < step.sentOn!
    ) {
      problems.push('วันที่คาดว่าจะได้คืนต้องไม่ก่อนวันส่ง');
    }
  }
  if (['replaced', 'credited', 'rejected'].includes(step.to)) {
    if (!isDay(step.resolvedOn)) problems.push('ต้องระบุวันที่ได้ผลเคลม');
  }
  if (step.to === 'credited' && !(Number(step.creditAmount) > 0)) {
    problems.push('ต้องระบุยอดเครดิตที่ได้');
  }
  if (step.to === 'rejected' && !step.outcomeNote?.trim()) {
    problems.push('ต้องระบุเหตุผลที่คู่ค้าปฏิเสธ');
  }
  return problems;
}

/** Sent, and past the day it was expected back. */
export function claimOverdue(
  claim: { status: string; expectedOn: string | null },
  today: string,
) {
  return (
    claim.status === 'sent' &&
    claim.expectedOn !== null &&
    claim.expectedOn < today
  );
}

/**
 * A spare's goods issue in SAP: B1 `Reference2` holds 11 characters — `SV`
 * and the first nine of the row's id, enough to be unique in practice and
 * to find the issue again after a timeout.
 */
export function issueReference(materialId: string) {
  return `SV${materialId.replace(/-/g, '').slice(0, 9).toUpperCase()}`;
}

/** Why a replacement unit cannot go on the asset. */
export function replaceProblems(input: {
  oldSerial: string | null;
  newSerial: string | null;
  reason: string;
}): string[] {
  const problems: string[] = [];
  if (!input.newSerial) problems.push('ต้องระบุหมายเลขเครื่องใหม่');
  if (input.newSerial && input.newSerial === input.oldSerial) {
    problems.push('หมายเลขเครื่องใหม่ซ้ำกับเครื่องเดิม');
  }
  if (!input.reason.trim()) problems.push('ต้องระบุเหตุผลที่เปลี่ยน');
  return problems;
}
