/**
 * CD-158 ประเมินความเสี่ยงกฎหมาย — the rules, apart from the database.
 */

export const RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];
export const ISSUE_SEVERITIES = ['low', 'medium', 'high'] as const;

export interface RiskIssue {
  title: string;
  detail?: string | null;
  clause?: string | null;
  severity: string;
  /** To be put to the executives. */
  escalate: boolean;
}

/** High and critical always go to the executives; so does a marked issue. */
export function opinionNeeded(
  level: string | null,
  issues: readonly Pick<RiskIssue, 'escalate'>[],
): boolean {
  if (!level) return false;
  return (
    level === 'high' ||
    level === 'critical' ||
    issues.some((issue) => issue.escalate)
  );
}

/**
 * What the executives were asked about: the level and the issues put to
 * them. A change to either asks again; rewording an issue kept in-house
 * does not.
 */
export function opinionKey(
  level: string,
  issues: readonly Pick<RiskIssue, 'title' | 'escalate'>[],
): string {
  const escalated = issues
    .filter((issue) => issue.escalate)
    .map((issue) => issue.title.trim())
    .sort();
  return JSON.stringify([level, escalated]);
}

/** What stops the assessment from being saved, in Thai. */
export function riskProblems(level: string, issues: readonly RiskIssue[]) {
  const problems: string[] = [];
  if (!RISK_LEVELS.includes(level as RiskLevel)) {
    problems.push('ระดับความเสี่ยงไม่ถูกต้อง');
  }
  issues.forEach((issue, index) => {
    const n = `ประเด็นที่ ${index + 1}`;
    if (!issue.title?.trim()) problems.push(`${n}: ต้องระบุประเด็น`);
    if (
      !ISSUE_SEVERITIES.includes(
        issue.severity as (typeof ISSUE_SEVERITIES)[number],
      )
    ) {
      problems.push(`${n}: ระดับของประเด็นไม่ถูกต้อง`);
    }
  });
  if ((level === 'high' || level === 'critical') && !issues.length) {
    problems.push('ความเสี่ยงสูงต้องระบุประเด็นที่ทำให้สูง');
  }
  return problems;
}

export type OpinionState =
  'not_needed' | 'missing' | 'draft' | 'pending' | 'approved' | 'rejected';

/**
 * May the contract be signed, as far as legal risk goes? Not assessed says
 * nothing either way; a needed opinion must have been given, and in favour.
 */
export function signReadiness(
  assessed: boolean,
  opinion: OpinionState,
): { ready: boolean | null; reason: string | null } {
  if (!assessed) return { ready: null, reason: 'ยังไม่ได้ประเมินความเสี่ยง' };
  if (opinion === 'not_needed' || opinion === 'approved') {
    return { ready: true, reason: null };
  }
  if (opinion === 'rejected') {
    return {
      ready: false,
      reason: 'ผู้บริหารไม่เห็นชอบ — ยังลงนามไม่ได้ ต้องแก้ไขแล้วประเมินใหม่',
    };
  }
  return {
    ready: false,
    reason: 'ความเสี่ยงสูง — ต้องได้ความเห็นผู้บริหารก่อนลงนาม',
  };
}
