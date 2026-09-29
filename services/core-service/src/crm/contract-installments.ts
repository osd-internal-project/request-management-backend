/**
 * CD-164 แผนการวางบิลตามงวด — the rules on a schedule, apart from the
 * database. Money is compared in satang so 33.33 + 33.33 + 33.34 is exactly
 * 100.00.
 */

export const INSTALLMENT_KINDS = [
  'deposit',
  'progress',
  'final',
  'retention',
] as const;
export type InstallmentKind = (typeof INSTALLMENT_KINDS)[number];

export const GUARANTEE_TYPES = ['bank_guarantee', 'cheque', 'cash'] as const;

export const KIND_LABEL: Record<InstallmentKind, string> = {
  deposit: 'เงินมัดจำ',
  progress: 'งวดตามความคืบหน้า',
  final: 'งวดสุดท้าย',
  retention: 'เงินประกันผลงาน',
};

export interface InstallmentInput {
  kind: string;
  label?: string | null;
  amount: number;
  dueOn?: string | null;
  dueNote?: string | null;
  milestone?: string | null;
  guaranteeType?: string | null;
  guaranteeAmount?: number | null;
}

export const satang = (amount: number) => Math.round(amount * 100);

const baht = (value: number) =>
  (value / 100).toLocaleString('th-TH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

/** The share of the contract value, to two places — for display only. */
export function shareOf(amount: number, value: number | null): number | null {
  if (!value) return null;
  return Math.round((amount / value) * 10_000) / 100;
}

/** Total, and how far it is from the contract value (+ over, − short). */
export function balanceOf(
  amounts: readonly number[],
  value: number | null,
): { total: number; difference: number | null; balanced: boolean } {
  const total = amounts.reduce((sum, amount) => sum + satang(amount), 0);
  const difference = value === null ? null : total - satang(value);
  return {
    total: total / 100,
    difference: difference === null ? null : difference / 100,
    balanced: difference === 0,
  };
}

/** What stops the schedule from being saved, in Thai; empty when it may be. */
export function scheduleProblems(
  rows: readonly InstallmentInput[],
  value: number | null,
): string[] {
  if (!rows.length) return [];
  const problems: string[] = [];
  if (value === null || value <= 0) {
    return ['ระบุมูลค่าสัญญาก่อนวางงวด'];
  }
  rows.forEach((row, index) => {
    const n = `งวดที่ ${index + 1}`;
    if (!INSTALLMENT_KINDS.includes(row.kind as InstallmentKind)) {
      problems.push(`${n}: ประเภทงวดไม่ถูกต้อง`);
      return;
    }
    // a fraction of a satang is a typo, not an amount
    if (
      !(row.amount > 0) ||
      Math.abs(satang(row.amount) - row.amount * 100) > 1e-6
    ) {
      problems.push(`${n}: จำนวนเงินต้องมากกว่า 0 และไม่เกินทศนิยม 2 ตำแหน่ง`);
    }
    if (!row.dueOn && !row.dueNote?.trim() && !row.milestone?.trim()) {
      problems.push(`${n}: ต้องระบุกำหนดชำระ หรือหมุดหมายที่ปลดล็อก`);
    }
    if (row.kind === 'deposit') {
      if (
        !row.guaranteeType ||
        !GUARANTEE_TYPES.includes(
          row.guaranteeType as (typeof GUARANTEE_TYPES)[number],
        )
      ) {
        problems.push(`${n}: เงินมัดจำต้องบันทึกหลักประกันที่ออกคู่กัน`);
      } else if (
        row.guaranteeAmount == null ||
        satang(row.guaranteeAmount) < satang(row.amount)
      ) {
        problems.push(`${n}: หลักประกันต้องไม่น้อยกว่าเงินมัดจำ`);
      }
    }
  });
  if (rows.filter((row) => row.kind === 'final').length > 1) {
    problems.push('งวดสุดท้ายมีได้งวดเดียว');
  }
  const { difference } = balanceOf(
    rows.map((row) => row.amount),
    value,
  );
  if (difference) {
    const gap = baht(Math.abs(satang(difference)));
    problems.push(
      difference > 0
        ? `ผลรวมทุกงวดเกินมูลค่าสัญญา ${gap} บาท`
        : `ผลรวมทุกงวดยังขาดอีก ${gap} บาท จากมูลค่าสัญญา`,
    );
  }
  return problems;
}
