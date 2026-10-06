/**
 * CD-268 — the campaign plan's arithmetic: budget lines per channel, actual
 * spend, and progress against the campaign's targets. Pure, so the screen and
 * the report agree on every number.
 */

const round2 = (value: number) => Math.round(value * 100) / 100;

export interface PlanLine {
  id: string;
  planned: number;
}

export interface PlanSpend {
  budgetLineId: string | null;
  amount: number;
  voided: boolean;
}

/** The campaign budget is the sum of its lines. */
export function plannedTotal(lines: readonly PlanLine[]): number {
  return round2(lines.reduce((sum, line) => sum + line.planned, 0));
}

/** Actual spend — voided entries never count. */
export function spentTotal(spends: readonly PlanSpend[]): number {
  return round2(
    spends
      .filter((spend) => !spend.voided)
      .reduce((sum, spend) => sum + spend.amount, 0),
  );
}

/** Spend per budget line; spend not tied to a line is keyed `''`. */
export function spentByLine(spends: readonly PlanSpend[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const spend of spends) {
    if (spend.voided) continue;
    const key = spend.budgetLineId ?? '';
    out.set(key, round2((out.get(key) ?? 0) + spend.amount));
  }
  return out;
}

/** Over plan: actual above planned, when there is a plan. */
export function overBudget(planned: number | null, spent: number): boolean {
  return planned !== null && spent > planned;
}

/** Share of a target reached, 0–∞ (null when there is no target). */
export function progress(target: number | null, actual: number): number | null {
  if (target === null || target <= 0) return null;
  return round2(actual / target);
}

export function lineProblems(
  lines: readonly { channel: string; planned: number }[],
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const channel = line.channel.trim();
    if (!channel) problems.push('ทุกบรรทัดต้องมีช่องทาง');
    else if (seen.has(channel.toLowerCase()))
      problems.push(`ช่องทาง ${channel} ซ้ำ — รวมเป็นบรรทัดเดียว`);
    seen.add(channel.toLowerCase());
    if (!(line.planned >= 0)) problems.push('งบต้องไม่ติดลบ');
  }
  return [...new Set(problems)];
}

export function spendProblems(input: {
  amount: number;
  spentOn: string;
  today: string;
}): string[] {
  const problems: string[] = [];
  if (!(input.amount > 0)) problems.push('จำนวนเงินต้องมากกว่า 0');
  if (input.spentOn > input.today) problems.push('วันที่จ่ายต้องไม่เกินวันนี้');
  return problems;
}
