/**
 * CD-175 เปิดโครงการ — the rules, apart from the database: when a contract
 * may become a project, and what is copied into the project's baseline.
 */
import {
  costEstimate,
  readBoq,
  readDeliverables,
  readLabor,
  readLines,
  readAssumptions,
  type QuoteState,
} from '../presales/solution-rules';

export const PROJECT_STATUSES = [
  'active',
  'on_hold',
  'closed',
  'cancelled',
] as const;
export type ProjectStatusCode = (typeof PROJECT_STATUSES)[number];

export const MAX_MEMBERS = 100;

export interface OpenableContract {
  status: string;
  kind: string;
  signedOn: Date | null;
  endOn: Date;
  /** The project already opened from it, if any. */
  projectNo: string | null;
}

/**
 * What stops this contract from becoming a project, in Thai: it must be a
 * contract of work (not an NDA or MSA), still active, signed by every party,
 * not past its end, and not opened already. `today` is a Bangkok day.
 */
export function openProblems(
  contract: OpenableContract,
  today: string,
): string[] {
  const problems: string[] = [];
  if (contract.projectNo) {
    problems.push(`เปิดโครงการจากสัญญานี้แล้ว (${contract.projectNo})`);
  }
  if (contract.kind === 'nda' || contract.kind === 'msa') {
    problems.push('สัญญารักษาความลับและข้อตกลงหลักเปิดเป็นโครงการไม่ได้');
  }
  if (contract.status !== 'active') {
    problems.push('สัญญาไม่อยู่ในสถานะใช้งาน');
  }
  if (!contract.signedOn) {
    problems.push(
      'สัญญายังไม่ได้ลงนามครบทุกฝ่าย — ลงนามผ่านระบบ หรือให้ฝ่ายกฎหมายบันทึกฉบับลงนาม',
    );
  }
  if (contract.endOn.toISOString().slice(0, 10) < today) {
    problems.push('สัญญาสิ้นสุดแล้ว');
  }
  return problems;
}

export interface BaselineSources {
  contract: {
    contractNo: string;
    title: string;
    value: number | null;
    currency: string;
    startOn: Date | null;
    endOn: Date;
    signedOn: Date | null;
    party: string;
  };
  /** The approved Solution version of the deal, if there is one. */
  version: {
    id: string;
    versionNo: number;
    solutionId: string;
    solutionTitle: string;
    inScope: unknown;
    outOfScope: unknown;
    deliverables: unknown;
    assumptions: unknown;
    boq: unknown;
    labor: unknown;
  } | null;
  quotes: readonly QuoteState[];
  /** The contract request's package (CD-145), when no approved version. */
  requestPackage: {
    solutionTitle: string | null;
    solutionVersionNo: number | null;
    inScope: unknown;
    outOfScope: unknown;
    deliverables: unknown;
  } | null;
  installments: readonly {
    seq: number;
    kind: string;
    label: string;
    amount: number;
    dueOn: Date | null;
    dueNote: string | null;
    milestone: string | null;
  }[];
}

const day = (value: Date | null) =>
  value ? value.toISOString().slice(0, 10) : null;

/**
 * The baseline a project starts from, and what it could not find. The
 * scope comes from the approved Solution version; without one, from the
 * contract request's package (scope only, no BOQ). Nothing here follows the
 * source afterwards.
 */
export function buildBaseline(
  sources: BaselineSources,
  today: Date,
): { baseline: Record<string, unknown>; missing: string[] } {
  const missing: string[] = [];
  const { version, requestPackage } = sources;
  const scopeFrom = version ?? requestPackage;
  const scope = {
    inScope: readLines(scopeFrom?.inScope),
    outOfScope: readLines(scopeFrom?.outOfScope),
    deliverables: readDeliverables(scopeFrom?.deliverables),
    assumptions: version ? readAssumptions(version.assumptions) : [],
  };
  if (!version) {
    missing.push(
      requestPackage
        ? 'ไม่พบ Solution ที่อนุมัติแล้ว — ใช้ขอบเขตงานจากคำขอจัดทำสัญญา (ไม่มี BOQ)'
        : 'ไม่พบ Solution ที่อนุมัติแล้วของดีลนี้',
    );
  }
  if (!scope.inScope.length) missing.push('ไม่มีขอบเขตงาน');
  if (!scope.deliverables.length) missing.push('ไม่มีรายการสิ่งส่งมอบ');

  const boq = version ? readBoq(version.boq) : [];
  const labor = version ? readLabor(version.labor) : [];
  if (version && !boq.length) missing.push('ไม่มี BOQ');
  const cost = version
    ? costEstimate(version.boq, version.labor, sources.quotes, today)
    : null;
  if (cost && cost.missing_cost) {
    missing.push(`BOQ ${cost.missing_cost} รายการยังไม่มีต้นทุน`);
  }

  if (!sources.installments.length) missing.push('ไม่มีแผนงวดวางบิล');
  if (sources.contract.value === null) missing.push('สัญญาไม่ได้ระบุมูลค่า');

  return {
    baseline: {
      contract: {
        contractNo: sources.contract.contractNo,
        title: sources.contract.title,
        party: sources.contract.party,
        value: sources.contract.value,
        currency: sources.contract.currency,
        startOn: day(sources.contract.startOn),
        endOn: day(sources.contract.endOn),
        signedOn: day(sources.contract.signedOn),
      },
      solution: version
        ? {
            solutionId: version.solutionId,
            title: version.solutionTitle,
            versionNo: version.versionNo,
          }
        : requestPackage?.solutionTitle
          ? {
              solutionId: null,
              title: requestPackage.solutionTitle,
              versionNo: requestPackage.solutionVersionNo,
            }
          : null,
      scope,
      boq,
      labor,
      cost: cost
        ? {
            lines: cost.lines.map((line) => ({
              index: line.index,
              productCode: line.productCode,
              name: line.name,
              quantity: line.quantity,
              unitCost: line.unitCost,
              source: line.source,
            })),
            materialsTotal: cost.materials_total,
            laborTotal: cost.labor_total,
            total: cost.total,
            missingCost: cost.missing_cost,
          }
        : null,
      installments: sources.installments.map((row) => ({
        seq: row.seq,
        kind: row.kind,
        label: row.label,
        amount: row.amount,
        dueOn: day(row.dueOn),
        dueNote: row.dueNote,
        milestone: row.milestone,
      })),
      capturedAt: today.toISOString(),
    },
    missing,
  };
}

export interface MemberInput {
  userId: string;
  role: string | null;
}

/** A team list as saved: one row per person, the manager not repeated. */
export function cleanMembers(
  members: readonly { user_id: string; role?: string | null }[],
  managerUserId: string,
): MemberInput[] {
  const seen = new Set<string>([managerUserId]);
  const rows: MemberInput[] = [];
  for (const member of members) {
    const userId = member.user_id?.trim();
    if (!userId || seen.has(userId)) continue;
    seen.add(userId);
    rows.push({ userId, role: member.role?.trim() || null });
  }
  return rows.slice(0, MAX_MEMBERS);
}
