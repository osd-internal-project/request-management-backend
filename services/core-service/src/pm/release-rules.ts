/**
 * CD-214 Release และ Environment — the rules, apart from the database:
 * what an environment and a release need, what runs where, and when a
 * release may go to production.
 */

export const ENV_KINDS = ['dev', 'uat', 'production'] as const;
export type EnvKind = (typeof ENV_KINDS)[number];
export const MAX_RELEASE_TEXT = 4000;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,49}$/;

/** An environment's own problems, in Thai. */
export function environmentProblems(input: {
  kind: string;
  name: string;
  url: string | null;
}): string[] {
  const problems: string[] = [];
  if (!(ENV_KINDS as readonly string[]).includes(input.kind)) {
    problems.push('ชนิดต้องเป็น dev, uat หรือ production');
  }
  if (!input.name.trim()) problems.push('ต้องตั้งชื่อ environment');
  if (input.name.length > 100) problems.push('ชื่อยาวเกิน 100 ตัวอักษร');
  if (input.url && !/^https?:\/\/\S+$/i.test(input.url)) {
    problems.push('URL ต้องขึ้นต้นด้วย http:// หรือ https://');
  }
  return problems;
}

/** A release's own problems, in Thai. */
export function releaseProblems(version: string): string[] {
  if (!version) return ['ต้องระบุเวอร์ชัน'];
  return VERSION.test(version)
    ? []
    : ['เวอร์ชันใช้ได้เฉพาะตัวอักษร ตัวเลข . _ + - และยาวไม่เกิน 50 ตัว'];
}

/**
 * What stops a deployment, in Thai. Production takes a release that ran on
 * UAT first, with no blocker open (a defect, CD-213, or a UAT point,
 * CD-222) — unless the manager overrides it, with the reason (a hotfix).
 */
export function deployProblems(input: {
  kind: string;
  onUat: boolean;
  hasUat: boolean;
  blockers: number;
  overrideReason: string;
  canEdit: boolean;
  deployedAt: Date;
  now: Date;
}): string[] {
  const problems: string[] = [];
  if (input.deployedAt.getTime() > input.now.getTime() + 60_000) {
    problems.push('เวลาที่ deploy ต้องไม่เกินตอนนี้');
  }
  if (input.kind !== 'production') return problems;
  if (input.overrideReason.trim()) {
    if (!input.canEdit) {
      problems.push('ข้ามเงื่อนไข production ได้เฉพาะผู้จัดการโครงการ');
    }
    return problems;
  }
  if (!input.hasUat) {
    problems.push(
      'โครงการยังไม่มี environment UAT — ต้องผ่าน UAT ก่อนขึ้น production',
    );
  } else if (!input.onUat) {
    problems.push('เวอร์ชันนี้ยังไม่เคย deploy บน UAT');
  }
  if (input.blockers > 0) {
    problems.push(
      `มีข้อบกพร่องหรือประเด็น UAT ระดับปิดกั้นค้าง ${input.blockers} รายการ`,
    );
  }
  return problems;
}

/** What runs on each environment: its latest deployment. */
export function currentOf<
  T extends { environmentId: string; deployedAt: Date },
>(deployments: readonly T[]): Map<string, T> {
  const current = new Map<string, T>();
  for (const row of deployments) {
    const seen = current.get(row.environmentId);
    if (!seen || row.deployedAt.getTime() > seen.deployedAt.getTime()) {
      current.set(row.environmentId, row);
    }
  }
  return current;
}
