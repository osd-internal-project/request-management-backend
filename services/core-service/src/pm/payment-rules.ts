/**
 * CD-193 ติดตามงวดชำระ — the rules of following a project's installments,
 * apart from the database: where each stands (paid, billed, billable,
 * waiting), whether it is late, and when its money is expected — the cash
 * the project should bring in, month by month.
 */

/** Days from billing to payment, until the contract's own terms say. */
export const DEFAULT_CREDIT_DAYS = 30;

export type PaymentState = 'paid' | 'invoiced' | 'billable' | 'waiting';

export interface InstallmentFacts {
  seq: number;
  kind: string;
  amount: number;
  dueOn: string | null;
  /** The milestone that unlocks it (CD-182), and its forecast (CD-178). */
  milestone: {
    status: string;
    achievedOn: string | null;
    forecast: string | null;
  } | null;
  billing: {
    invoicedOn: string | null;
    invoicedAmount: number | null;
    paidOn: string | null;
    paidAmount: number | null;
  } | null;
}

const plusDays = (day: string, days: number) => {
  const at = new Date(`${day}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
};

/**
 * Where an installment stands, when it is expected to be billed and paid,
 * and whether it is late: paid → done; billed → due `creditDays` after
 * the invoice; not yet billed → billable once its milestone is achieved
 * (a deposit once the contract is signed), expected on the milestone's
 * forecast or its own due day.
 */
export function paymentStatus(
  row: InstallmentFacts,
  context: { signed: boolean; today: string; creditDays?: number },
) {
  const credit = context.creditDays ?? DEFAULT_CREDIT_DAYS;
  const billing = row.billing;
  if (billing?.paidOn) {
    return {
      state: 'paid' as PaymentState,
      expectedBillOn: billing.invoicedOn,
      expectedPayOn: billing.paidOn,
      overdue: false,
      received: billing.paidAmount ?? row.amount,
    };
  }
  if (billing?.invoicedOn) {
    const payOn = plusDays(billing.invoicedOn, credit);
    return {
      state: 'invoiced' as PaymentState,
      expectedBillOn: billing.invoicedOn,
      expectedPayOn: payOn,
      overdue: payOn < context.today,
      received: 0,
    };
  }
  const unlocked =
    row.kind === 'deposit'
      ? context.signed
      : row.milestone
        ? row.milestone.status === 'achieved'
        : false;
  const billOn = unlocked
    ? (row.milestone?.achievedOn ?? row.dueOn ?? context.today)
    : (row.milestone?.forecast ?? row.dueOn);
  return {
    state: (unlocked ? 'billable' : 'waiting') as PaymentState,
    expectedBillOn: billOn,
    expectedPayOn: billOn ? plusDays(billOn, credit) : null,
    // its own due day passed and it is not billed yet
    overdue: row.dueOn !== null && row.dueOn < context.today,
    received: 0,
  };
}

/** Money expected in by month ("2026-11"), split into received and to come. */
export function cashForecast(
  rows: readonly {
    amount: number;
    state: PaymentState;
    expectedPayOn: string | null;
    received: number;
  }[],
) {
  const months = new Map<string, { received: number; expected: number }>();
  let unscheduled = 0;
  for (const row of rows) {
    if (!row.expectedPayOn) {
      unscheduled += row.amount;
      continue;
    }
    const key = row.expectedPayOn.slice(0, 7);
    const bucket = months.get(key) ?? { received: 0, expected: 0 };
    if (row.state === 'paid') bucket.received += row.received;
    else bucket.expected += row.amount;
    months.set(key, bucket);
  }
  return {
    months: [...months.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, sums]) => ({ month, ...sums })),
    unscheduled,
  };
}

/** What stops a billing record, in Thai. */
export function billingProblems(input: {
  invoicedOn: string | null;
  invoicedAmount: number | null;
  paidOn: string | null;
  paidAmount: number | null;
  today: string;
}): string[] {
  const problems: string[] = [];
  if (input.paidOn && !input.invoicedOn) {
    problems.push('บันทึกการรับเงินได้หลังวางบิลแล้ว');
  }
  if (input.invoicedOn && input.paidOn && input.paidOn < input.invoicedOn) {
    problems.push('วันรับเงินต้องไม่ก่อนวันวางบิล');
  }
  for (const [label, day] of [
    ['วันวางบิล', input.invoicedOn],
    ['วันรับเงิน', input.paidOn],
  ] as const) {
    if (day && day > input.today) problems.push(`${label}ต้องไม่เกินวันนี้`);
  }
  for (const [label, amount] of [
    ['ยอดวางบิล', input.invoicedAmount],
    ['ยอดรับเงิน', input.paidAmount],
  ] as const) {
    if (amount !== null && (!Number.isFinite(amount) || amount < 0)) {
      problems.push(`${label}ต้องไม่ติดลบ`);
    }
  }
  return problems;
}
