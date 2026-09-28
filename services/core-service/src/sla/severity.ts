import type { RequestSeverity } from '@prisma/client';
import { AppError } from '@request-management/share';

/** CD-67 — worst first; the order screens list them in. */
export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;

export interface SeverityTarget {
  /** Working hours (under the type's coverage) until someone must respond. */
  readonly responseHours: number;
  /** Working hours until it must be resolved — the resolution clock's budget. */
  readonly resolutionHours: number;
}

export type SeverityTargets = Readonly<Record<RequestSeverity, SeverityTarget>>;

/**
 * What the admin screen offers as a starting point (user decision 28 ก.ย.
 * 2569). A default suggested on screen, never applied silently: a type
 * becomes a case type only when an admin saves targets for it.
 */
export const DEFAULT_SEVERITY_TARGETS: SeverityTargets = {
  critical: { responseHours: 1, resolutionHours: 4 },
  high: { responseHours: 4, resolutionHours: 24 },
  medium: { responseHours: 8, resolutionHours: 72 },
  low: { responseHours: 24, resolutionHours: 120 },
};

/**
 * The stored JSON as targets, or null when absent or malformed. Malformed
 * reads as "not a case type" rather than throwing: the column is written only
 * through `assertSeverityTargets`, so a bad row is corruption to log, not a
 * reason to stop every submit of that type.
 */
export function readSeverityTargets(value: unknown): SeverityTargets | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Record<string, unknown>;
  const result: Partial<Record<RequestSeverity, SeverityTarget>> = {};

  for (const severity of SEVERITIES) {
    const entry = source[severity] as Record<string, unknown> | undefined;
    const response = Number(entry?.responseHours);
    const resolution = Number(entry?.resolutionHours);
    if (!(response > 0) || !(resolution > 0)) return null;
    result[severity] = { responseHours: response, resolutionHours: resolution };
  }
  return result as SeverityTargets;
}

/**
 * Why a submitted set is not acceptable, or [] — every level present, both
 * numbers positive, response no later than resolution, and a worse level
 * never given more time than a milder one.
 */
export function severityTargetProblems(value: unknown): string[] {
  const targets = readSeverityTargets(value);
  if (!targets) {
    return ['ต้องกำหนดเวลาตอบกลับและเวลาแก้ไข (มากกว่า 0) ครบทุกระดับ'];
  }
  const problems: string[] = [];
  for (const severity of SEVERITIES) {
    const target = targets[severity];
    if (target.responseHours > target.resolutionHours) {
      problems.push(`${severity}: เวลาตอบกลับต้องไม่เกินเวลาแก้ไข`);
    }
  }
  for (let i = 1; i < SEVERITIES.length; i += 1) {
    const worse = targets[SEVERITIES[i - 1]];
    const milder = targets[SEVERITIES[i]];
    if (
      worse.responseHours > milder.responseHours ||
      worse.resolutionHours > milder.resolutionHours
    ) {
      problems.push(
        `${SEVERITIES[i - 1]}: ระดับที่รุนแรงกว่าต้องได้เวลาไม่มากกว่า ${SEVERITIES[i]}`,
      );
    }
  }
  return problems;
}

/**
 * CD-67 — a case type's clocks are set by severity; a case submitted without
 * one would silently run on the type's flat hours and have no response clock.
 */
export function assertSeverityGiven(
  isCaseType: boolean,
  severity: RequestSeverity | null | undefined,
): void {
  if (isCaseType && !severity) {
    throw new AppError(
      'VALIDATION_FAILED',
      'ประเภทคำขอนี้เป็นเคส — ต้องเลือกระดับความรุนแรงก่อนยื่น',
      [{ field: 'severity', reason: 'required' }],
    );
  }
}
