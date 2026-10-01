/**
 * CD-183 ความเสี่ยงโครงการ — the rules of a project's risks, apart from the
 * database: scored as Pre-Sales scores them (CD-141, likelihood × impact),
 * taken over once from the technical team and Legal, reviewed on a cycle,
 * and put before the executives when high with no plan.
 */
import { riskLevel, type RiskLevel } from '../presales/solution-rules';

export const PROJECT_RISK_STATUSES = [
  'open',
  'mitigated',
  'accepted',
  'closed',
] as const;
export const MIN_REVIEW_DAYS = 1;
export const MAX_REVIEW_DAYS = 180;

export function levelOf(likelihood: number, impact: number): RiskLevel {
  return riskLevel(likelihood * impact);
}

export interface Draft {
  source: 'technical' | 'legal';
  sourceRef: string;
  title: string;
  description: string | null;
  likelihood: number;
  impact: number;
  response: string | null;
}

/** Open technical risks of the approved Solution, not yet taken. */
export function fromSolutionRisks(
  rows: readonly {
    id: string;
    title: string;
    description: string;
    likelihood: number;
    impact: number;
    mitigation: string;
    status: string;
  }[],
  taken: ReadonlySet<string>,
): Draft[] {
  return rows
    .filter((row) => row.status === 'open' && !taken.has(`solution:${row.id}`))
    .map((row) => ({
      source: 'technical',
      sourceRef: `solution:${row.id}`,
      title: row.title,
      description: row.description || null,
      likelihood: clamp(row.likelihood),
      impact: clamp(row.impact),
      response: row.mitigation || null,
    }));
}

/**
 * Legal's issues on the contract, not yet taken: their severity sets the
 * score (low 2×2, medium 3×3, high 4×4), and one Legal put before the
 * executives counts at the highest impact.
 */
export function fromLegalIssues(
  issues: readonly {
    title?: string;
    detail?: string;
    clause?: string;
    severity?: string;
    escalate?: boolean;
  }[],
  assessmentId: string,
  taken: ReadonlySet<string>,
): Draft[] {
  const scale: Record<string, number> = { low: 2, medium: 3, high: 4 };
  return issues
    .map((issue, index) => ({ issue, ref: `legal:${assessmentId}:${index}` }))
    .filter(({ issue, ref }) => issue.title?.trim() && !taken.has(ref))
    .map(({ issue, ref }) => {
      const base = scale[issue.severity ?? ''] ?? 3;
      return {
        source: 'legal',
        sourceRef: ref,
        title: issue.title!.trim(),
        description:
          [issue.clause ? `ข้อ ${issue.clause}` : null, issue.detail]
            .filter(Boolean)
            .join(' — ') || null,
        likelihood: base,
        impact: issue.escalate ? 5 : base,
        response: null,
      };
    });
}

const clamp = (value: number) =>
  Math.min(5, Math.max(1, Math.round(value) || 1));

/** An open high or critical risk with nobody on it or no plan. */
export function needsPlan(risk: {
  status: string;
  likelihood: number;
  impact: number;
  ownerUserId: string | null;
  response: string | null;
}): boolean {
  const level = levelOf(risk.likelihood, risk.impact);
  return (
    risk.status === 'open' &&
    (level === 'high' || level === 'critical') &&
    (!risk.ownerUserId || !risk.response?.trim())
  );
}

/** The day after `fromDay` + `days` — when the next review is due. */
export function nextReviewOn(fromDay: string, days: number): string {
  const at = new Date(`${fromDay}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

export function reviewOverdue(
  risk: { status: string; nextReviewOn: string | null },
  today: string,
): boolean {
  return (
    risk.status === 'open' &&
    risk.nextReviewOn !== null &&
    risk.nextReviewOn < today
  );
}

/** What stops a risk from being saved, in Thai. */
export function riskProblems(input: {
  title: string;
  likelihood: number;
  impact: number;
  reviewEveryDays: number;
}): string[] {
  const problems: string[] = [];
  if (!input.title.trim()) problems.push('ต้องระบุความเสี่ยง');
  for (const [label, value] of [
    ['โอกาสเกิด', input.likelihood],
    ['ผลกระทบ', input.impact],
  ] as const) {
    if (!Number.isInteger(value) || value < 1 || value > 5) {
      problems.push(`${label}ต้องเป็น 1 ถึง 5`);
    }
  }
  if (
    !Number.isInteger(input.reviewEveryDays) ||
    input.reviewEveryDays < MIN_REVIEW_DAYS ||
    input.reviewEveryDays > MAX_REVIEW_DAYS
  ) {
    problems.push(
      `รอบทบทวนต้องอยู่ระหว่าง ${MIN_REVIEW_DAYS} ถึง ${MAX_REVIEW_DAYS} วัน`,
    );
  }
  return problems;
}
