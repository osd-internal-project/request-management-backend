/**
 * CD-253 ตัวจุดชนวนวางบิลรายงวด — the gate, apart from the database
 * (handover point 10: never bill before the customer accepts, never bill an
 * installment twice). What unlocks an installment depends on its kind:
 *
 * - deposit — the contract is signed by both sides;
 * - progress — its milestone achieved, the round's certificate signed, and
 *   no open point left from a conditional acceptance (unless an executive
 *   approved an exception);
 * - final — the same, and every milestone of the project done;
 * - retention — the warranty over.
 */

export const INSTALLMENT_KINDS = [
  'deposit',
  'progress',
  'final',
  'retention',
] as const;

/** Our reference in SAP (`NumAtCard`) — apart from service billing's `SVB-`. */
export function installmentReference(contractNo: string, seq: number) {
  return `INS-${contractNo}-${seq}`;
}

export interface BillingFacts {
  kind: string;
  today: string;
  contractSigned: boolean;
  hasCustomer: boolean;
  /** Billed already: here (not cancelled), or recorded by hand (CD-193). */
  billed: 'here' | 'manual' | null;
  milestone: { title: string; status: string } | null;
  certificateSigned: boolean;
  openPoints: number;
  exceptionApproved: boolean;
  /** Milestones of the project not yet achieved (cancelled ones aside). */
  milestonesOpen: number;
  /** The last day of the warranty; null = none recorded. */
  warrantyEnds: string | null;
}

/** What stands in the way, and whether an exception could lift it. */
export function billingBlockers(f: BillingFacts): {
  blockers: string[];
  /** Only open points remain — an executive may approve billing anyway. */
  exceptionable: boolean;
} {
  const blockers: string[] = [];
  if (f.billed === 'here') blockers.push('งวดนี้ส่งวางบิลแล้ว');
  if (f.billed === 'manual')
    blockers.push('งวดนี้บันทึกการวางบิลด้วยมือแล้ว (CD-193)');
  if (!f.hasCustomer)
    blockers.push('สัญญานี้ไม่ได้ผูกกับลูกค้าในทะเบียน — ส่งเข้า SAP ไม่ได้');
  let openPointsBlock = false;
  if (f.kind === 'deposit') {
    if (!f.contractSigned) blockers.push('สัญญายังไม่ได้ลงนามครบทั้งสองฝ่าย');
  } else if (f.kind === 'progress' || f.kind === 'final') {
    if (!f.milestone) {
      blockers.push('งวดนี้ยังไม่ได้ผูกกับหมุดหมายของโครงการ');
    } else if (f.milestone.status !== 'achieved') {
      blockers.push(`หมุดหมาย "${f.milestone.title}" ยังไม่บรรลุ`);
    }
    if (f.milestone && !f.certificateSigned) {
      blockers.push('ใบรับรองการตรวจรับของเฟสนี้ยังไม่ได้ลงนาม');
    }
    if (f.openPoints > 0 && !f.exceptionApproved) {
      blockers.push(
        `รายการค้างจากการรับมอบมีเงื่อนไขยังไม่ปิด ${f.openPoints} ข้อ`,
      );
      openPointsBlock = true;
    }
    if (f.kind === 'final' && f.milestonesOpen > 0) {
      blockers.push(
        `ยังมีหมุดหมายที่ไม่บรรลุ ${f.milestonesOpen} รายการ — งวดสุดท้ายต้องตรวจรับครบทุกเฟส`,
      );
    }
  } else if (f.kind === 'retention') {
    if (!f.warrantyEnds) {
      blockers.push('ยังไม่มีระยะประกันของสัญญานี้ (ตั้งจากการตรวจรับ)');
    } else if (f.warrantyEnds >= f.today) {
      blockers.push(`ยังไม่พ้นระยะประกัน (สิ้นสุด ${f.warrantyEnds})`);
    }
  } else {
    blockers.push(`ชนิดงวด ${f.kind} ไม่รู้จัก`);
  }
  return {
    blockers,
    exceptionable: openPointsBlock && blockers.length === 1,
  };
}

/** Whether a retention installment is due for its reminder `days` ahead. */
export function retentionDue(
  warrantyEnds: string | null,
  today: string,
  days: number,
) {
  if (!warrantyEnds) return false;
  const left =
    (Date.parse(`${warrantyEnds}T00:00:00Z`) -
      Date.parse(`${today}T00:00:00Z`)) /
    86_400_000;
  return left <= days;
}
