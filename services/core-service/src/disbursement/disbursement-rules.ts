/**
 * การเบิก — the rules with no I/O: status moves, the form → lines mapping,
 * and the settlement arithmetic. Money is handled in satang (integers) so a
 * sum never drifts; docs/disbursement.md §4–5.
 */

export type DisbursementKind = 'ADVANCE' | 'PETTY_CASH';

export type DisbursementStatus =
  | 'PENDING_HEAD'
  | 'RETURNED'
  | 'PENDING_VERIFY'
  | 'PENDING_EXEC'
  | 'APPROVED'
  | 'PARTIALLY_PAID'
  | 'PAID'
  | 'CLEARING'
  | 'CLOSED'
  | 'REJECTED'
  | 'CANCELLED';

const MOVES: Readonly<Record<DisbursementStatus, readonly DisbursementStatus[]>> =
  {
    PENDING_HEAD: ['PENDING_VERIFY', 'RETURNED', 'REJECTED', 'CANCELLED'],
    RETURNED: ['PENDING_HEAD', 'PENDING_VERIFY', 'CANCELLED'],
    PENDING_VERIFY: [
      'PENDING_EXEC',
      'APPROVED',
      'RETURNED',
      'REJECTED',
      'CANCELLED',
    ],
    PENDING_EXEC: ['APPROVED', 'PENDING_VERIFY', 'REJECTED', 'CANCELLED'],
    APPROVED: ['PARTIALLY_PAID', 'PAID', 'CANCELLED'],
    // Another instalment, or a voided one: the status follows the amount paid.
    PARTIALLY_PAID: ['PARTIALLY_PAID', 'PAID', 'APPROVED'],
    PAID: ['CLEARING', 'CLOSED', 'PARTIALLY_PAID', 'APPROVED'],
    CLEARING: ['PAID', 'CLOSED'],
    CLOSED: [],
    REJECTED: [],
    CANCELLED: [],
  };

/** Money has left the company: the request may no longer be cancelled. */
export const MONEY_OUT: readonly DisbursementStatus[] = [
  'PARTIALLY_PAID',
  'PAID',
  'CLEARING',
  'CLOSED',
];

export function canMove(
  from: DisbursementStatus,
  to: DisbursementStatus,
): boolean {
  return MOVES[from].includes(to);
}

/** PETTY_CASH has no clearing: what was paid is what was spent. */
export function moveBlocker(
  kind: DisbursementKind,
  from: DisbursementStatus,
  to: DisbursementStatus,
): string | null {
  if (kind === 'PETTY_CASH' && to === 'CLEARING') {
    return 'เงินสดย่อยไม่มีขั้นเคลียร์ค่าใช้จ่าย';
  }
  return canMove(from, to)
    ? null
    : `ใบเบิกสถานะ ${from} ทำรายการนี้ไม่ได้`;
}

/** After an instalment or a void: nothing paid, part of it, or all of it. */
export function statusForPaid(paidSatang: number, requestedSatang: number): DisbursementStatus {
  if (paidSatang <= 0) return 'APPROVED';
  return paidSatang >= requestedSatang ? 'PAID' : 'PARTIALLY_PAID';
}

/** Why this instalment may not be recorded, or null. */
export function payBlocker(
  amountSatang: number,
  paidSatang: number,
  requestedSatang: number,
): string | null {
  if (amountSatang <= 0) return 'ยอดจ่ายต้องมากกว่า 0';
  if (paidSatang + amountSatang > requestedSatang) {
    return `จ่ายเกินยอดอนุมัติ — จ่ายได้อีกไม่เกิน ${formatBaht(requestedSatang - paidSatang)} บาท`;
  }
  return null;
}

/** The status a fresh or re-sent disbursement starts at, read off its request. */
export function startStatus(requestStatus: string): DisbursementStatus {
  return requestStatus === 'pending_approval' ? 'PENDING_HEAD' : 'PENDING_VERIFY';
}

/** What a request event does to its disbursement; null = nothing. */
export function statusOnRequestEvent(
  current: DisbursementStatus,
  event:
    | 'pre_approved'
    | 'returned'
    | 'rejected'
    | 'cancelled',
): DisbursementStatus | null {
  const target: Record<typeof event, DisbursementStatus> = {
    pre_approved: 'PENDING_VERIFY',
    returned: 'RETURNED',
    rejected: 'REJECTED',
    cancelled: 'CANCELLED',
  };
  const to = target[event];
  return current !== to && canMove(current, to) ? to : null;
}

/** The flow-v2 step codes a company's disbursements are worked at. */
export interface WorkSteps {
  readonly verifyStep: string | null;
  readonly execStep: string | null;
  readonly payStep: string | null;
  readonly clearStep: string | null;
  readonly doneStep: string | null;
}

/** Where the ticket now stands → the disbursement's status; null = nothing to change. */
export function statusOnStep(
  steps: WorkSteps,
  current: DisbursementStatus,
  ticket: { stepCode: string; status: string },
): DisbursementStatus | null {
  const target: DisbursementStatus | null =
    ticket.status === 'draft' || ticket.status === 'returned'
      ? 'RETURNED'
      : ticket.stepCode === steps.verifyStep
        ? 'PENDING_VERIFY'
        : ticket.stepCode === steps.execStep
          ? 'PENDING_EXEC'
          : ticket.stepCode === steps.payStep
            ? 'APPROVED'
            : ticket.status === 'pending_approval'
              ? 'PENDING_HEAD'
              : null;
  return target && target !== current && canMove(current, target)
    ? target
    : null;
}

/** Why the ticket may not leave its step yet, or null. Going back is never held. */
export function leaveBlocker(
  steps: WorkSteps,
  row: { kind: DisbursementKind; status: DisbursementStatus; verified: boolean },
  move: { from: string; backward: boolean },
): string | null {
  if (move.backward) return null;
  if (move.from === steps.verifyStep && !row.verified) {
    return 'ยังไม่ได้บันทึกผลตรวจสอบของบัญชีที่หน้าการเบิก';
  }
  const paidOut = row.kind === 'PETTY_CASH' ? ['CLOSED'] : MONEY_OUT;
  if (move.from === steps.payStep && !paidOut.includes(row.status)) {
    return 'ยังไม่ได้บันทึกการจ่ายเงินที่หน้าการเบิก';
  }
  if (move.from === steps.clearStep && row.status !== 'CLOSED') {
    return 'ยังไม่ได้เคลียร์และปิดการเบิก';
  }
  return null;
}

/** Statuses at which a re-sent request replaces the estimate. */
export const RESNAPSHOT_AT: readonly DisbursementStatus[] = [
  'PENDING_HEAD',
  'RETURNED',
  'PENDING_VERIFY',
];

export interface LineInput {
  readonly description: string;
  readonly costCenter: string | null;
  readonly amountSatang: number;
  readonly note: string | null;
  readonly receiptDate: string | null;
}

export function toSatang(value: unknown): number | null {
  const amount =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : NaN;
  if (!Number.isFinite(amount)) return null;
  return Math.round(amount * 100);
}

export function fromSatang(satang: number): string {
  return (satang / 100).toFixed(2);
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

/** `expense_items` of the request form → lines; a row with no positive amount is a problem. */
export function linesFromItems(items: unknown): {
  lines: LineInput[];
  problems: string[];
} {
  const rows = Array.isArray(items) ? items : [];
  const problems: string[] = [];
  const lines: LineInput[] = [];
  rows.forEach((row: unknown, index) => {
    const item = (row ?? {}) as Record<string, unknown>;
    const amountSatang = toSatang(item.amount);
    const description = text(item.description);
    if (!description) problems.push(`รายการที่ ${index + 1}: ไม่มีรายการค่าใช้จ่าย`);
    if (amountSatang === null || amountSatang <= 0) {
      problems.push(`รายการที่ ${index + 1}: จำนวนเงินต้องมากกว่า 0`);
    }
    lines.push({
      description: description ?? '',
      costCenter: text(item.cost_center),
      amountSatang: amountSatang ?? 0,
      note: text(item.note),
      receiptDate: text(item.receipt_date),
    });
  });
  if (!lines.length) problems.push('ต้องมีรายการค่าใช้จ่ายอย่างน้อย 1 รายการ');
  return { lines, problems };
}

export function totalSatang(lines: readonly LineInput[]): number {
  return lines.reduce((sum, line) => sum + line.amountSatang, 0);
}

/** The header fields the request form carries (FI05 / FI06 field names). */
export function headerFromForm(form: Record<string, unknown>) {
  return {
    payee: text(form.payee),
    costCenter: text(form.cost_center),
    purpose: text(form.purpose),
    neededBy: text(form.needed_by),
    clearBy: text(form.clear_by),
    soNo: text(form.so_no),
    soSubject: text(form.so_subject),
    ticketNo: text(form.ticket_no),
    projectCode: text(form.project_code),
    fundCode: text(form.fund_code),
  };
}

/** Paid vs spent: the requester returns the rest, or the company pays the overspend. */
export function settlement(paidSatang: number, actualSatang: number) {
  const diff = paidSatang - actualSatang;
  return {
    refundSatang: diff > 0 ? diff : 0,
    extraPaySatang: diff < 0 ? -diff : 0,
  };
}

export interface FundFacts {
  readonly custodianUserId: string;
  readonly perClaimLimitSatang: number;
  readonly cashOnHandSatang: number;
  readonly active: boolean;
}

/** `12,350.00` — how an amount reads in a notification. */
export function formatBaht(satang: number): string {
  return (satang / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** `15/09/2569` — a date in the Buddhist era, as the screens print it. */
export function thaiDate(value: Date | null): string | null {
  if (!value) return null;
  const [year, month, day] = value.toISOString().slice(0, 10).split('-');
  return `${day}/${month}/${Number(year) + 543}`;
}
