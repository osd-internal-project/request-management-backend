/**
 * CD-153..156 — the arithmetic and the checks of a contract's terms, kept
 * pure so the rules read in one place and test without a database.
 */

export const PENALTY_PERIODS = ['day', 'week', 'month', 'occurrence'] as const;
export const PENALTY_BASES = [
  'contract_value',
  'undelivered_value',
  'monthly_fee',
  'other',
] as const;

export interface TermsInput {
  liabilityUnlimited?: boolean;
  liabilityCapAmount?: number | null;
  penaltyRatePct?: number | null;
  penaltyPeriod?: string | null;
  penaltyBasis?: string | null;
  penaltyBasisNote?: string | null;
  penaltyCapPct?: number | null;
  penaltyCapAmount?: number | null;
  warrantyMonths?: number | null;
  acceptedOn?: string | null;
  terminationNoticeDays?: number | null;
  terminationSteps?: string[];
}

/**
 * CD-153 — a cap above the contract's value, or no cap at all, is the
 * company promising more than it earns: executives must approve it. A
 * contract with no value yet cannot be compared — only "unlimited" asks.
 */
export function liabilityNeedsApproval(
  terms: { liabilityUnlimited: boolean; liabilityCapAmount: number | null },
  contractValue: number | null,
): boolean {
  if (terms.liabilityUnlimited) return true;
  if (terms.liabilityCapAmount === null || contractValue === null) return false;
  return terms.liabilityCapAmount > contractValue;
}

/** Same cap as before? A changed cap voids the approval given for the old. */
export function liabilityKey(terms: {
  liabilityUnlimited: boolean;
  liabilityCapAmount: number | null;
}): string {
  return terms.liabilityUnlimited
    ? 'unlimited'
    : String(terms.liabilityCapAmount ?? '');
}

/** CD-154 — the most the penalty can reach, in money, when it can be known. */
export function penaltyCeiling(
  terms: { penaltyCapPct: number | null; penaltyCapAmount: number | null },
  contractValue: number | null,
): number | null {
  if (terms.penaltyCapAmount !== null) return terms.penaltyCapAmount;
  if (terms.penaltyCapPct !== null && contractValue !== null) {
    return Math.round(contractValue * terms.penaltyCapPct) / 100;
  }
  return null;
}

/**
 * CD-155 — the warranty runs from the real acceptance date for `months`;
 * before acceptance it has not started (not "from signing").
 */
export function warrantyPeriod(
  acceptedOn: string | null,
  months: number | null,
): { startsOn: string; endsOn: string } | null {
  if (!acceptedOn || !months) return null;
  const start = new Date(`${acceptedOn}T00:00:00Z`);
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + months);
  // 31 Jan + 1 month lands in March in JS — clamp to the month's last day.
  if (end.getUTCDate() !== start.getUTCDate()) end.setUTCDate(0);
  end.setUTCDate(end.getUTCDate() - 1);
  return {
    startsOn: acceptedOn,
    endsOn: end.toISOString().slice(0, 10),
  };
}

/** Every problem with the input, in words — empty when it is fine. */
export function termProblems(input: TermsInput): string[] {
  const problems: string[] = [];
  if (input.liabilityUnlimited && input.liabilityCapAmount) {
    problems.push('ความรับผิดเลือกได้อย่างเดียว — ไม่จำกัด หรือระบุเพดาน');
  }
  if (
    input.penaltyPeriod &&
    !(PENALTY_PERIODS as readonly string[]).includes(input.penaltyPeriod)
  ) {
    problems.push('รอบคิดค่าปรับไม่ถูกต้อง');
  }
  if (
    input.penaltyBasis &&
    !(PENALTY_BASES as readonly string[]).includes(input.penaltyBasis)
  ) {
    problems.push('ฐานคำนวณค่าปรับไม่ถูกต้อง');
  }
  if (input.penaltyBasis === 'other' && !input.penaltyBasisNote?.trim()) {
    problems.push('ฐานคำนวณค่าปรับ "อื่น ๆ" ต้องอธิบาย');
  }
  if (
    input.penaltyRatePct !== null &&
    input.penaltyRatePct !== undefined &&
    (!input.penaltyPeriod || !input.penaltyBasis)
  ) {
    problems.push('อัตราค่าปรับต้องมีรอบคิดและฐานคำนวณ');
  }
  if (input.penaltyCapPct && input.penaltyCapAmount) {
    problems.push('เพดานค่าปรับเลือกได้อย่างเดียว — ร้อยละ หรือจำนวนเงิน');
  }
  if (
    input.penaltyCapPct !== null &&
    input.penaltyCapPct !== undefined &&
    input.penaltyCapPct > 100
  ) {
    problems.push('เพดานค่าปรับเกินร้อยละ 100 ของมูลค่าสัญญา');
  }
  if (
    input.acceptedOn &&
    !/^\d{4}-\d{2}-\d{2}$/.test(input.acceptedOn.slice(0, 10))
  ) {
    problems.push('วันตรวจรับไม่ถูกต้อง');
  }
  if ((input.terminationSteps ?? []).some((step) => !step.trim())) {
    problems.push('ขั้นตอนเมื่อยกเลิกสัญญาต้องไม่ว่าง');
  }
  return problems;
}

/**
 * The approval's state as the contract page shows it, from the request's
 * status. `approved` only once the request came through.
 */
export function approvalStateOf(
  needed: boolean,
  request: { status: string } | null,
): 'not_needed' | 'missing' | 'draft' | 'pending' | 'approved' | 'rejected' {
  if (!needed) return 'not_needed';
  // not asked yet — or asking failed; the reason travels separately
  if (!request) return 'missing';
  if (
    ['approved', 'in_progress', 'completed', 'closed'].includes(request.status)
  ) {
    return 'approved';
  }
  if (['rejected', 'cancelled'].includes(request.status)) return 'rejected';
  // created but not submitted — it has not reached anyone yet
  if (request.status === 'draft' || request.status === 'returned') {
    return 'draft';
  }
  return 'pending';
}
