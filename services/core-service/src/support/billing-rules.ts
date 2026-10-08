/**
 * CD-242 ส่งข้อมูลเรียกเก็บเงินงานบริการ — the pure part: when a job may be
 * billed, what a line adds up to, and what makes a charge sendable.
 */

/** The case is done: the doing team finished, or the requester closed it. */
export const BILLABLE_DONE = ['completed', 'approved', 'closed'];

export const MAX_BILLING_LINES = 50;

export interface BillingLineInput {
  productCode: string | null;
  description: string;
  quantity: number;
  unit: string | null;
  unitPrice: number;
  discountPct: number;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/** Quantity × price, less the line's discount, to the satang. */
export function lineTotal(line: {
  quantity: number;
  unitPrice: number;
  discountPct: number;
}): number {
  return round2(line.quantity * line.unitPrice * (1 - line.discountPct / 100));
}

export function netTotal(lines: readonly BillingLineInput[]): number {
  return round2(lines.reduce((sum, line) => sum + lineTotal(line), 0));
}

/** Our reference on the SAP draft (`NumAtCard`): one per job, readable. */
export function billingReference(requestNo: string | null, id: string) {
  return `SVB-${requestNo ?? id.slice(0, 8).toUpperCase()}`;
}

/**
 * Why this job cannot be billed (yet): only a confirmed billed job, and
 * only once the work is done — the charge is for work delivered.
 */
export function prepareBlocker(
  order: { billing: string | null },
  requestStatus: string,
  /** CD-228 — out-of-contract items the customer agreed to. */
  agreedExtras = 0,
): string | null {
  if (order.billing !== 'billable' && !agreedExtras) {
    return 'เรียกเก็บได้เฉพาะงานที่ยืนยันว่าเก็บเงินเพิ่ม หรือมีงานนอกสัญญาที่ลูกค้ายินยอม';
  }
  if (!BILLABLE_DONE.includes(requestStatus)) {
    return 'เรียกเก็บได้เมื่องานเสร็จแล้ว';
  }
  return null;
}

/** The lines as saved: each one sensible, at most MAX_BILLING_LINES. */
export function lineProblems(lines: readonly BillingLineInput[]): string[] {
  const problems: string[] = [];
  if (lines.length > MAX_BILLING_LINES) {
    problems.push(`ไม่เกิน ${MAX_BILLING_LINES} บรรทัด`);
  }
  lines.forEach((line, index) => {
    const at = `บรรทัด ${index + 1}`;
    if (!line.description.trim()) problems.push(`${at}: ต้องมีรายละเอียด`);
    if (!(line.quantity > 0)) problems.push(`${at}: จำนวนต้องมากกว่า 0`);
    if (!(line.unitPrice >= 0)) problems.push(`${at}: ราคาต้องไม่ติดลบ`);
    if (!(line.discountPct >= 0 && line.discountPct <= 100)) {
      problems.push(`${at}: ส่วนลดต้องอยู่ระหว่าง 0–100%`);
    }
  });
  return problems;
}

/** What still stops a charge from going to SAP. */
export function confirmBlocker(lines: readonly BillingLineInput[]) {
  if (!lines.length) return 'ยังไม่มีรายการเรียกเก็บ';
  if (netTotal(lines) <= 0) return 'ยอดเรียกเก็บต้องมากกว่า 0';
  return lineProblems(lines)[0] ?? null;
}

/**
 * The first line, from what the customer agreed to before work started
 * (CD-239): one service line at the estimate. Nothing when no estimate.
 */
export function estimateLine(
  subject: string,
  estimate: number | null,
): BillingLineInput | null {
  if (estimate === null || !(estimate > 0)) return null;
  return {
    productCode: null,
    description: `ค่าบริการ ${subject}`.trim().slice(0, 200),
    quantity: 1,
    unit: null,
    unitPrice: estimate,
    discountPct: 0,
  };
}
