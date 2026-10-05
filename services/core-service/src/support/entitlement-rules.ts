/**
 * CD-237 สิทธิ์การรับบริการ — the rules, apart from the database: a
 * warranty's period from the acceptance date, where an entitlement stands on
 * a day, which one answers for an asset, and what one needs.
 */
import { severityTargetProblems } from '../sla/severity';

export const ENTITLEMENT_KINDS = ['warranty', 'service_contract'] as const;
export const COVERAGES = ['H24X7', 'H8X7', 'H8X5'] as const;
export type EntitlementState = 'upcoming' | 'active' | 'expired' | 'cancelled';

/** Stronger coverage first: round the clock, then 8 h every day, then office hours. */
const STRENGTH: Record<string, number> = { H24X7: 3, H8X7: 2, H8X5: 1 };

const at = (day: string) => Date.parse(`${day}T00:00:00Z`);
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The last day of `months` months from `from` (warranty from acceptance). */
export function warrantyEnd(from: string, months: number): string {
  const start = new Date(at(from));
  const end = new Date(
    Date.UTC(
      start.getUTCFullYear(),
      start.getUTCMonth() + months,
      start.getUTCDate(),
    ),
  );
  // 31 Jan + 1 month lands on 3 Mar; keep to the month's end instead
  if (end.getUTCDate() !== start.getUTCDate()) end.setUTCDate(0);
  return iso(end.getTime() - 86_400_000);
}

export function entitlementState(
  row: { startOn: string; endOn: string; cancelled: boolean },
  on: string,
): EntitlementState {
  if (row.cancelled) return 'cancelled';
  if (on < row.startOn) return 'upcoming';
  if (on > row.endOn) return 'expired';
  return 'active';
}

/**
 * What answers for an asset on a day: every active entitlement, the
 * strongest coverage first, then the one that runs longest.
 */
export function coverageOn<
  T extends {
    startOn: string;
    endOn: string;
    cancelled: boolean;
    coverage: string | null;
  },
>(rows: readonly T[], on: string): T[] {
  return rows
    .filter((row) => entitlementState(row, on) === 'active')
    .sort(
      (a, b) =>
        (STRENGTH[b.coverage ?? ''] ?? 0) - (STRENGTH[a.coverage ?? ''] ?? 0) ||
        b.endOn.localeCompare(a.endOn),
    );
}

/** Visits left of a quota; null = unlimited. */
export function quotaLeft(quota: number | null, used: number): number | null {
  return quota === null ? null : Math.max(quota - used, 0);
}

/** An entitlement's own problems, in Thai. */
export function entitlementProblems(input: {
  kind: string;
  title: string;
  startOn: string;
  endOn: string;
  coverage: string | null;
  severityTargets: unknown;
  correctiveQuota: number | null;
  preventiveQuota: number | null;
}): string[] {
  const problems: string[] = [];
  if (!(ENTITLEMENT_KINDS as readonly string[]).includes(input.kind)) {
    problems.push('ชนิดต้องเป็นประกัน หรือสัญญาบริการ');
  }
  if (!input.title.trim()) problems.push('ต้องตั้งชื่อสิทธิ์');
  const day = /^\d{4}-\d{2}-\d{2}$/;
  if (!day.test(input.startOn) || !day.test(input.endOn)) {
    problems.push('ต้องระบุวันเริ่มและวันสิ้นสุด');
  } else if (input.endOn < input.startOn) {
    problems.push('วันสิ้นสุดต้องไม่ก่อนวันเริ่ม');
  }
  if (
    input.coverage &&
    !(COVERAGES as readonly string[]).includes(input.coverage)
  ) {
    problems.push('ช่วงเวลาบริการต้องเป็น 24x7, 8x7 หรือ 8x5');
  }
  if (input.severityTargets !== null && input.severityTargets !== undefined) {
    problems.push(...severityTargetProblems(input.severityTargets));
  }
  for (const [label, value] of [
    ['แก้เหตุ', input.correctiveQuota],
    ['บำรุงรักษา', input.preventiveQuota],
  ] as const) {
    if (
      value !== null &&
      (!Number.isInteger(value) || value < 0 || value > 1000)
    ) {
      problems.push(
        `โควตา${label}ต้องเป็นจำนวนเต็ม 0–1000 หรือว่าง (ไม่จำกัด)`,
      );
    }
  }
  return problems;
}
