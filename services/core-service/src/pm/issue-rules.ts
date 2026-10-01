/**
 * CD-184 ปัญหาระหว่างทาง — the rules of an issue, apart from the database:
 * what it must say, when it is late, and the change request it becomes.
 */

export const ISSUE_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;

/** What stops an issue from being saved, in Thai. */
export function issueProblems(input: {
  title: string;
  severity: string;
  ownerUserId: string | null;
  dueOn: string | null;
  costImpact: number;
}): string[] {
  const problems: string[] = [];
  if (!input.title.trim()) problems.push('ต้องระบุปัญหา');
  if (!(ISSUE_SEVERITIES as readonly string[]).includes(input.severity)) {
    problems.push('ระดับความรุนแรงไม่ถูกต้อง');
  }
  if (!input.ownerUserId) problems.push('ต้องกำหนดเจ้าของปัญหา');
  if (!input.dueOn || !/^\d{4}-\d{2}-\d{2}$/.test(input.dueOn)) {
    problems.push('ต้องกำหนดเส้นตายการแก้ไข');
  }
  if (!Number.isFinite(input.costImpact) || input.costImpact < 0) {
    problems.push('ผลกระทบต่อต้นทุนต้องไม่ติดลบ');
  }
  return problems;
}

export function issueOverdue(
  issue: { status: string; dueOn: string },
  today: string,
): boolean {
  return issue.status === 'open' && issue.dueOn < today;
}

/**
 * The change request an issue becomes when it changes what was sold: its
 * days, and its cost as one line.
 */
export function changeFromIssue(issue: {
  seq: number;
  title: string;
  description: string | null;
  scheduleImpactDays: number;
  costImpact: number;
}) {
  const label = `I-${issue.seq}`;
  return {
    title: `${label}: ${issue.title}`,
    reason: issue.description?.trim() || `แก้ปัญหา ${label}`,
    schedule_days: issue.scheduleImpactDays,
    cost_lines: issue.costImpact
      ? [
          {
            category: 'other',
            description: `ผลกระทบจากปัญหา ${label}`,
            quantity: 1,
            unit_cost: issue.costImpact,
          },
        ]
      : [],
  };
}
