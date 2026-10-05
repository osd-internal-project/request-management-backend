/**
 * CD-246 ปัญหาที่เกิดซ้ำ — the pure part: which repeated faults look like one
 * problem, how a problem moves, and which open problem a new job matches.
 */

export interface RepeatThresholds {
  days: number;
  asset: number;
  model: number;
  customerModel: number;
}

export interface JobFact {
  id: string;
  assetId: string | null;
  productCode: string | null;
  customerId: string | null;
}

export type ProblemScope = 'asset' | 'model' | 'customer_model';

export interface RepeatGroup {
  /** Stable across runs: scope and value, so a dismissal can name it. */
  key: string;
  scope: ProblemScope;
  assetId: string | null;
  productCode: string | null;
  customerId: string | null;
  jobIds: string[];
}

function groupBy(
  jobs: readonly JobFact[],
  keyOf: (job: JobFact) => string | null,
) {
  const groups = new Map<string, JobFact[]>();
  for (const job of jobs) {
    const key = keyOf(job);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), job]);
  }
  return groups;
}

/**
 * Corrective jobs (already inside the window, not yet under a problem)
 * grouped three ways — one unit, one model anywhere, one model at one
 * customer — each kept when it reaches its threshold. A group whose jobs
 * are exactly another, narrower group's is dropped (the narrower says more).
 */
export function repeatGroups(
  jobs: readonly JobFact[],
  limits: RepeatThresholds,
): RepeatGroup[] {
  const out: RepeatGroup[] = [];
  for (const [assetId, list] of groupBy(jobs, (job) => job.assetId)) {
    if (list.length < limits.asset) continue;
    const first = list[0];
    out.push({
      key: `asset:${assetId}`,
      scope: 'asset',
      assetId,
      productCode: first.productCode,
      customerId: first.customerId,
      jobIds: list.map((job) => job.id),
    });
  }
  for (const [key, list] of groupBy(jobs, (job) =>
    job.productCode && job.customerId
      ? `${job.customerId}|${job.productCode}`
      : null,
  )) {
    if (list.length < limits.customerModel) continue;
    const [customerId, productCode] = key.split('|');
    out.push({
      key: `customer_model:${key}`,
      scope: 'customer_model',
      assetId: null,
      productCode,
      customerId,
      jobIds: list.map((job) => job.id),
    });
  }
  for (const [productCode, list] of groupBy(jobs, (job) => job.productCode)) {
    if (list.length < limits.model) continue;
    out.push({
      key: `model:${productCode}`,
      scope: 'model',
      assetId: null,
      productCode,
      customerId: null,
      jobIds: list.map((job) => job.id),
    });
  }
  // the same jobs twice: keep the first (narrowest) reading
  const seen = new Set<string>();
  return out
    .filter((group) => {
      const ids = [...group.jobIds].sort().join(',');
      if (seen.has(ids)) return false;
      seen.add(ids);
      return true;
    })
    .sort((a, b) => b.jobIds.length - a.jobIds.length);
}

/** Dismissed groups come back only once they have grown. */
export function stillDismissed(
  group: RepeatGroup,
  dismissed: ReadonlyMap<string, number>,
) {
  const size = dismissed.get(group.key);
  return size !== undefined && group.jobIds.length <= size;
}

export const PROBLEM_OPEN = ['open', 'investigating', 'known_error'];

const NEXT: Record<string, string[]> = {
  open: ['investigating', 'known_error', 'resolved'],
  investigating: ['known_error', 'resolved'],
  known_error: ['investigating', 'resolved'],
  resolved: ['investigating', 'closed'],
  closed: [],
};

export interface ProblemFacts {
  workaround: string | null;
  rootCause: string | null;
  permanentFix: string | null;
}

/** Why a problem cannot take this step. */
export function problemStepProblems(
  from: string,
  to: string,
  facts: ProblemFacts,
): string[] {
  if (!(NEXT[from] ?? []).includes(to)) {
    return [`เปลี่ยนสถานะปัญหาจาก ${from} เป็น ${to} ไม่ได้`];
  }
  const problems: string[] = [];
  if (to === 'known_error' && !facts.workaround?.trim()) {
    problems.push('รู้สาเหตุแล้วต้องมีวิธีแก้ชั่วคราวให้ช่างใช้');
  }
  if (to === 'resolved') {
    if (!facts.rootCause?.trim()) problems.push('ต้องระบุสาเหตุราก');
    if (!facts.permanentFix?.trim()) problems.push('ต้องระบุวิธีแก้ถาวร');
  }
  return problems;
}

/** Why a problem's scope is incomplete. */
export function scopeProblems(input: {
  scope: string;
  assetId: string | null;
  productCode: string | null;
  customerId: string | null;
}): string[] {
  if (input.scope === 'asset' && !input.assetId) {
    return ['ปัญหาระดับเครื่องต้องระบุอุปกรณ์'];
  }
  if (input.scope === 'model' && !input.productCode) {
    return ['ปัญหาระดับรุ่นต้องระบุรหัสสินค้า'];
  }
  if (
    input.scope === 'customer_model' &&
    (!input.productCode || !input.customerId)
  ) {
    return ['ปัญหาระดับลูกค้า+รุ่นต้องระบุทั้งลูกค้าและรหัสสินค้า'];
  }
  if (!['asset', 'model', 'customer_model'].includes(input.scope)) {
    return ['ขอบเขตต้องเป็น เครื่อง / รุ่น / ลูกค้า+รุ่น'];
  }
  return [];
}

/** Open problems this job falls under, by their scope. */
export function matchingProblems<
  T extends {
    status: string;
    scope: string;
    assetId: string | null;
    productCode: string | null;
    customerId: string | null;
  },
>(job: JobFact, problems: readonly T[]): T[] {
  return problems.filter((problem) => {
    if (!PROBLEM_OPEN.includes(problem.status)) return false;
    if (problem.scope === 'asset') return problem.assetId === job.assetId;
    if (problem.scope === 'model') {
      return (
        Boolean(job.productCode) && problem.productCode === job.productCode
      );
    }
    return (
      Boolean(job.productCode) &&
      problem.productCode === job.productCode &&
      problem.customerId === job.customerId
    );
  });
}
