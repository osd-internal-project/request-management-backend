/**
 * CD-192 รายงานโครงการ — a project's health, from what the other cards
 * already know: work behind the plan (CD-188), milestones running late
 * (CD-178/182), open risks rated high or critical (CD-183), issues past
 * their date (CD-184), the budget grown by changes (CD-179/185), and
 * installments overdue (CD-193). Each adds points; the total against the
 * two thresholds in CRM settings gives green, amber or red. The weights
 * are here, stated once; the thresholds are configuration.
 */

export const HEALTH_LEVELS = ['green', 'amber', 'red'] as const;
export type HealthLevel = (typeof HEALTH_LEVELS)[number];

export const DEFAULT_HEALTH_AMBER = 20;
export const DEFAULT_HEALTH_RED = 40;

export interface HealthFacts {
  /** Work done minus work planned by today, in points; null = no dated plan. */
  variance: number | null;
  /** Milestones not reached whose due date passed or whose forecast is past it. */
  milestonesLate: number;
  risksHigh: number;
  risksCritical: number;
  issuesOverdue: number;
  /** The budget in force over the first one confirmed, in %; null = no budget. */
  costGrowthPct: number | null;
  paymentsOverdue: number;
  /** CD-176 — the work not yet received from Sales and Pre-Sales; null = received. */
  intake?: 'pending' | 'returned' | null;
}

export interface HealthFactor {
  key: string;
  label: string;
  points: number;
  detail: string;
}

export interface Health {
  score: number;
  level: HealthLevel;
  factors: HealthFactor[];
}

const capped = (each: number, count: number, cap: number) =>
  Math.min(each * count, cap);

/** What adds to the score, the largest first; empty when nothing does. */
export function healthFactors(facts: HealthFacts): HealthFactor[] {
  const factors: HealthFactor[] = [];
  const behind = facts.variance === null ? 0 : -facts.variance;
  const behindPoints =
    behind >= 20 ? 30 : behind >= 10 ? 15 : behind >= 5 ? 5 : 0;
  if (behindPoints) {
    factors.push({
      key: 'behind',
      label: 'งานช้ากว่าแผน',
      points: behindPoints,
      detail: `ช้ากว่าแผน ${Math.round(behind * 10) / 10} จุด`,
    });
  }
  if (facts.milestonesLate) {
    factors.push({
      key: 'milestones',
      label: 'milestone ล่าช้า',
      points: capped(15, facts.milestonesLate, 30),
      detail: `${facts.milestonesLate} milestone`,
    });
  }
  if (facts.risksHigh || facts.risksCritical) {
    factors.push({
      key: 'risks',
      label: 'ความเสี่ยงระดับสูง/วิกฤติ',
      points: Math.min(facts.risksCritical * 20 + facts.risksHigh * 10, 30),
      detail: `วิกฤติ ${facts.risksCritical} · สูง ${facts.risksHigh}`,
    });
  }
  if (facts.issuesOverdue) {
    factors.push({
      key: 'issues',
      label: 'ปัญหาเลยกำหนดแก้',
      points: capped(5, facts.issuesOverdue, 20),
      detail: `${facts.issuesOverdue} ข้อ`,
    });
  }
  const growth = facts.costGrowthPct ?? 0;
  const growthPoints = growth >= 20 ? 20 : growth >= 10 ? 10 : 0;
  if (growthPoints) {
    factors.push({
      key: 'cost',
      label: 'งบเพิ่มจากที่ยืนยัน',
      points: growthPoints,
      detail: `เพิ่ม ${Math.round(growth * 10) / 10}%`,
    });
  }
  if (facts.paymentsOverdue) {
    factors.push({
      key: 'payments',
      label: 'งวดชำระเลยกำหนด',
      points: capped(10, facts.paymentsOverdue, 20),
      detail: `${facts.paymentsOverdue} งวด`,
    });
  }
  if (facts.intake) {
    factors.push({
      key: 'intake',
      label: 'ยังไม่ได้รับมอบงาน',
      points: 10,
      detail:
        facts.intake === 'returned'
          ? 'ตีกลับแล้ว รอทีมขาย/เทคนิคแก้'
          : 'รอผู้จัดการโครงการตรวจรายการรับมอบ',
    });
  }
  return factors.sort((a, b) => b.points - a.points);
}

/** The thresholds as configured; a red below amber is lifted to amber. */
export function healthThresholds(amber: number | null, red: number | null) {
  const a = amber ?? DEFAULT_HEALTH_AMBER;
  const r = red ?? DEFAULT_HEALTH_RED;
  return { amber: a, red: Math.max(r, a) };
}

export function projectHealth(
  facts: HealthFacts,
  thresholds: { amber: number; red: number },
): Health {
  const factors = healthFactors(facts);
  const score = factors.reduce((sum, factor) => sum + factor.points, 0);
  const level: HealthLevel =
    score >= thresholds.red
      ? 'red'
      : score >= thresholds.amber
        ? 'amber'
        : 'green';
  return { score, level, factors };
}

/** Red first, then by score, then the project number — the portfolio's order. */
export function byRisk<
  T extends {
    health: { score: number; level: HealthLevel };
    projectNo: string;
  },
>(rows: readonly T[]): T[] {
  const rank: Record<HealthLevel, number> = { red: 0, amber: 1, green: 2 };
  return [...rows].sort(
    (a, b) =>
      rank[a.health.level] - rank[b.health.level] ||
      b.health.score - a.health.score ||
      a.projectNo.localeCompare(b.projectNo),
  );
}

/** The Monday a Bangkok day falls in — the week a status report covers. */
export function weekStart(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  const offset = (date.getUTCDay() + 6) % 7;
  return new Date(date.getTime() - offset * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

export const MAX_REPORT_TEXT = 4000;
