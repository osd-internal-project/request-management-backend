/**
 * CD-228 บำรุงรักษาและสนับสนุน (CD-19 Engineer) — work found outside the
 * contract once a job has started, apart from the database: what a proposal
 * must say, what the customer may decide, what holds the job open, and the
 * lines it adds to the job's charge (CD-242).
 */
import type { BillingLineInput } from './billing-rules';

export const EXTRA_STATUSES = [
  'proposed',
  'agreed',
  'declined',
  'cancelled',
] as const;
export type ExtraStatus = (typeof EXTRA_STATUSES)[number];

export const MAX_EXTRA_TEXT = 2000;
export const MAX_EXTRAS_PER_JOB = 30;

/** What stops a proposal from being recorded, in Thai. */
export function proposalProblems(input: {
  description: string;
  reason: string;
  estimate: number;
}): string[] {
  const problems: string[] = [];
  if (!input.description.trim()) problems.push('ต้องระบุงานที่ต้องทำเพิ่ม');
  if (!input.reason.trim()) problems.push('ต้องระบุว่าทำไมอยู่นอกสัญญา');
  if (!Number.isFinite(input.estimate) || !(input.estimate > 0)) {
    problems.push('ต้องระบุประมาณการค่าใช้จ่ายมากกว่า 0');
  }
  return problems;
}

/** Only a proposal waiting for the customer may be decided or withdrawn. */
export function decideBlocker(status: string): string | null {
  return status === 'proposed' ? null : 'รายการนี้ตัดสินไปแล้ว';
}

/** The job may not close while the customer has not answered. */
export function extrasCloseBlocker(
  extras: readonly { seq: number; status: string }[],
): string | null {
  const waiting = extras.filter((row) => row.status === 'proposed');
  if (!waiting.length) return null;
  return `งานนอกสัญญารอลูกค้าตอบ: ${waiting.map((row) => `X-${row.seq}`).join(', ')} — บันทึกยินยอมหรือปฏิเสธก่อนแจ้งงานเสร็จ`;
}

/** The charge lines of what the customer agreed to. */
export function extraLines(
  extras: readonly {
    seq: number;
    description: string;
    estimate: number;
    status: string;
  }[],
): BillingLineInput[] {
  return extras
    .filter((row) => row.status === 'agreed')
    .map((row) => ({
      productCode: null,
      description: `งานนอกสัญญา X-${row.seq}: ${row.description}`
        .trim()
        .slice(0, 200),
      quantity: 1,
      unit: null,
      unitPrice: row.estimate,
      discountPct: 0,
    }));
}
