/**
 * CD-132 — the rules of a Solution's versions, pure so they are tested on
 * their own.
 */
export const ASSUMPTION_CATEGORIES = [
  'technical',
  'customer',
  'third_party',
  'commercial',
  // CD-133 — a limit the design works within (site, regulation, legacy).
  'constraint',
] as const;
export type AssumptionCategory = (typeof ASSUMPTION_CATEGORIES)[number];

export const ASSUMPTION_CATEGORY_LABELS: Record<AssumptionCategory, string> = {
  technical: 'ทางเทคนิค',
  customer: 'สิ่งที่ต้องพึ่งพาลูกค้า',
  third_party: 'สิ่งที่ต้องพึ่งพาบุคคลที่สาม',
  commercial: 'เชิงพาณิชย์',
  constraint: 'ข้อจำกัด',
};

/**
 * CD-133 — what the work depends on someone else for. These carry who is
 * responsible and by when, and go into the contract as assumptions.
 */
export const DEPENDENCY_CATEGORIES: readonly AssumptionCategory[] = [
  'customer',
  'third_party',
];

export interface Assumption {
  category: AssumptionCategory;
  text: string;
  /** CD-133 — dependencies only: who must deliver it. */
  owner?: string;
  /** CD-133 — dependencies only: needed by (YYYY-MM-DD). */
  neededBy?: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isIsoDate = (value: string) =>
  ISO_DATE.test(value) &&
  !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime());

/** The dependency fields of one assumption, kept only on a dependency. */
function dependencyOf(
  category: AssumptionCategory,
  owner: unknown,
  neededBy: unknown,
): Pick<Assumption, 'owner' | 'neededBy'> {
  if (!DEPENDENCY_CATEGORIES.includes(category)) return {};
  return {
    ...(typeof owner === 'string' && owner.trim()
      ? { owner: owner.trim() }
      : {}),
    ...(typeof neededBy === 'string' && isIsoDate(neededBy)
      ? { neededBy }
      : {}),
  };
}

export const MAX_ASSUMPTIONS = 100;
export const MAX_ASSUMPTION_LENGTH = 1000;

/** What a stored `assumptions` column holds, read defensively. */
export function readAssumptions(value: unknown): Assumption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const { category, text, owner, neededBy } = entry as Record<
      string,
      unknown
    >;
    if (
      typeof text !== 'string' ||
      !text.trim() ||
      !(ASSUMPTION_CATEGORIES as readonly unknown[]).includes(category)
    ) {
      return [];
    }
    return [
      {
        category: category as AssumptionCategory,
        text: text.trim(),
        ...dependencyOf(category as AssumptionCategory, owner, neededBy),
      },
    ];
  });
}

/**
 * Assumptions as a draft saves them: blank lines dropped, text trimmed.
 * Returns the problems instead of throwing so every one is named at once.
 */
export function cleanAssumptions(
  input: readonly {
    category?: string;
    text?: string;
    owner?: string;
    needed_by?: string;
  }[],
): { assumptions: Assumption[]; problems: string[] } {
  const problems: string[] = [];
  const assumptions: Assumption[] = [];
  input.forEach((entry, index) => {
    const text = entry.text?.trim() ?? '';
    if (!text) return;
    const where = `สมมติฐานข้อ ${index + 1}`;
    if (
      !(ASSUMPTION_CATEGORIES as readonly unknown[]).includes(entry.category)
    ) {
      problems.push(`${where}: ไม่รู้จักหมวด "${entry.category ?? ''}"`);
      return;
    }
    if (text.length > MAX_ASSUMPTION_LENGTH) {
      problems.push(`${where}: ยาวเกิน ${MAX_ASSUMPTION_LENGTH} ตัวอักษร`);
      return;
    }
    const neededBy = entry.needed_by?.trim() ?? '';
    if (neededBy && !isIsoDate(neededBy)) {
      problems.push(`${where}: วันที่ต้องพร้อมไม่ถูกต้อง`);
      return;
    }
    if ((entry.owner?.trim().length ?? 0) > 200) {
      problems.push(`${where}: ผู้รับผิดชอบยาวเกิน 200 ตัวอักษร`);
      return;
    }
    const category = entry.category as AssumptionCategory;
    assumptions.push({
      category,
      text,
      ...dependencyOf(category, entry.owner, neededBy),
    });
  });
  if (assumptions.length > MAX_ASSUMPTIONS) {
    problems.push(`สมมติฐานได้ไม่เกิน ${MAX_ASSUMPTIONS} ข้อ`);
  }
  return { assumptions, problems };
}

/**
 * Why a draft cannot be locked yet — a locked version is what goes forward
 * (to approval, to the customer, into the contract), so it must say what the
 * solution is and how it is built.
 */
export function lockGaps(version: {
  summary: string;
  design: string;
  feasibility?: FeasibilityVerdict;
  feasibilityNote?: string;
}): string[] {
  const gaps: string[] = [];
  if (!version.summary.trim()) gaps.push('ยังไม่มีสรุปทางออก');
  if (!version.design.trim()) gaps.push('ยังไม่มีรายละเอียดการออกแบบ');
  // CD-133 — every locked version says whether it can be done.
  const problem = feasibilityProblem(
    version.feasibility ?? 'unassessed',
    version.feasibilityNote ?? '',
  );
  if (problem) gaps.push(problem);
  return gaps;
}

// --- CD-133 feasibility ---------------------------------------------------------

export const FEASIBILITY_VERDICTS = [
  'unassessed',
  'feasible',
  'conditional',
  'not_feasible',
] as const;
export type FeasibilityVerdict = (typeof FEASIBILITY_VERDICTS)[number];

export const FEASIBILITY_LABELS: Record<FeasibilityVerdict, string> = {
  unassessed: 'ยังไม่ประเมิน',
  feasible: 'เป็นไปได้',
  conditional: 'เป็นไปได้แบบมีเงื่อนไข',
  not_feasible: 'ไม่เป็นไปได้',
};

/** Why the verdict cannot stand as it is, or null. */
export function feasibilityProblem(
  verdict: FeasibilityVerdict,
  note: string,
): string | null {
  if (verdict === 'unassessed') return 'ยังไม่ได้ประเมินความเป็นไปได้';
  if (verdict === 'conditional' && !note.trim()) {
    return 'ระบุเงื่อนไขที่ทำให้เป็นไปได้';
  }
  if (verdict === 'not_feasible' && !note.trim()) {
    return 'ระบุเหตุผลที่ไม่เป็นไปได้';
  }
  return null;
}

/** One assumption as a line of text — with who and by when on a dependency. */
export function assumptionLine(item: Assumption): string {
  const extra = [
    ...(item.owner ? [`ผู้รับผิดชอบ: ${item.owner}`] : []),
    ...(item.neededBy ? [`ต้องพร้อมภายใน ${item.neededBy}`] : []),
  ];
  return `[${ASSUMPTION_CATEGORY_LABELS[item.category]}] ${item.text}${
    extra.length ? ` (${extra.join(' · ')})` : ''
  }`;
}

/**
 * CD-133 — what goes into the contract request (CD-81) as its assumptions:
 * the dependencies and constraints first — they are what the customer
 * signs up to — then the rest, and the conditions of a conditional verdict.
 */
export function contractAssumptionsText(version: {
  assumptions: unknown;
  feasibility: FeasibilityVerdict;
  feasibilityNote: string;
}): string {
  const all = readAssumptions(version.assumptions);
  const first = all.filter(
    (item) =>
      DEPENDENCY_CATEGORIES.includes(item.category) ||
      item.category === 'constraint',
  );
  const rest = all.filter((item) => !first.includes(item));
  const lines = [...first, ...rest].map(
    (item, index) => `${index + 1}. ${assumptionLine(item)}`,
  );
  if (version.feasibility === 'conditional' && version.feasibilityNote.trim()) {
    lines.push(`เงื่อนไขความเป็นไปได้: ${version.feasibilityNote.trim()}`);
  }
  return lines.join('\n');
}

/**
 * The request fields a Solution starts from — what Sales wrote in the
 * "ขอ Solution" form (CD-130). Only the known keys, as text.
 */
export const BRIEF_FIELDS = [
  'requirement',
  'scope',
  'site',
  'timeline',
  'decision_maker',
  'budget_range',
  'constraints',
  'competitors',
  'needs_demo',
] as const;

export function briefOf(formData: unknown): Record<string, string> {
  const data =
    formData && typeof formData === 'object'
      ? (formData as Record<string, unknown>)
      : {};
  const brief: Record<string, string> = {};
  for (const key of BRIEF_FIELDS) {
    const value = data[key];
    if (typeof value === 'string' && value.trim()) brief[key] = value.trim();
    if (typeof value === 'boolean') brief[key] = value ? 'ใช่' : 'ไม่ใช่';
  }
  return brief;
}

// --- CD-131 requirement analysis -------------------------------------------------

export const REQUIREMENT_KINDS = ['business', 'technical'] as const;
export type RequirementKind = (typeof REQUIREMENT_KINDS)[number];

export const REQUIREMENT_ASSESSMENTS = [
  'unassessed',
  'feasible',
  'not_feasible',
  'needs_info',
] as const;
export type RequirementAssessment = (typeof REQUIREMENT_ASSESSMENTS)[number];

export interface RequirementState {
  assessment: RequirementAssessment;
  customerAnswer: string | null;
}

/** An item still waiting on the customer: asked, not yet answered. */
export function waitingOnCustomer(row: RequirementState): boolean {
  return row.assessment === 'needs_info' && !row.customerAnswer?.trim();
}

export function requirementCounts(rows: readonly RequirementState[]) {
  return {
    total: rows.length,
    unassessed: rows.filter((row) => row.assessment === 'unassessed').length,
    feasible: rows.filter((row) => row.assessment === 'feasible').length,
    not_feasible: rows.filter((row) => row.assessment === 'not_feasible')
      .length,
    needs_info: rows.filter((row) => row.assessment === 'needs_info').length,
    waiting_customer: rows.filter(waitingOnCustomer).length,
  };
}

/**
 * Why the analysis stops a version from locking (user decision 29 ก.ย. 2569):
 * a design is not fixed while an item is unassessed or the customer has not
 * answered what was asked.
 */
export function requirementGaps(rows: readonly RequirementState[]): string[] {
  const counts = requirementCounts(rows);
  const gaps: string[] = [];
  if (counts.unassessed) {
    gaps.push(`ยังไม่ได้ประเมินความต้องการ ${counts.unassessed} ข้อ`);
  }
  if (counts.waiting_customer) {
    gaps.push(`ยังรอลูกค้าตอบ ${counts.waiting_customer} ข้อ`);
  }
  return gaps;
}

/** A question to the customer must say what is being asked. */
export function assessmentProblem(
  assessment: RequirementAssessment,
  note: string,
): string | null {
  if (assessment === 'needs_info' && !note.trim()) {
    return 'ระบุสิ่งที่ต้องถามลูกค้าในหมายเหตุ';
  }
  if (assessment === 'not_feasible' && !note.trim()) {
    return 'ระบุเหตุผลที่ทำไม่ได้ในหมายเหตุ';
  }
  return null;
}

// --- CD-134 scope of work --------------------------------------------------------

export interface Deliverable {
  title: string;
  description: string;
  /** How the customer accepts it — each one ticked off at delivery (CD-20). */
  criteria: string[];
}

export const MAX_SCOPE_ITEMS = 100;
export const MAX_DELIVERABLES = 50;
export const MAX_CRITERIA = 30;
export const MAX_SCOPE_TEXT = 1000;

/** A stored list of lines, read defensively. */
export function readLines(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((line) =>
    typeof line === 'string' && line.trim() ? [line.trim()] : [],
  );
}

export function readDeliverables(value: unknown): Deliverable[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const { title, description, criteria } = entry as Record<string, unknown>;
    if (typeof title !== 'string' || !title.trim()) return [];
    return [
      {
        title: title.trim(),
        description: typeof description === 'string' ? description.trim() : '',
        criteria: readLines(criteria),
      },
    ];
  });
}

/** Lines as a draft saves them: blank ones dropped, the rest trimmed. */
export function cleanLines(
  input: readonly (string | undefined)[],
  label: string,
): { lines: string[]; problems: string[] } {
  const problems: string[] = [];
  const lines: string[] = [];
  input.forEach((raw, index) => {
    const line = raw?.trim() ?? '';
    if (!line) return;
    if (line.length > MAX_SCOPE_TEXT) {
      problems.push(
        `${label} ข้อ ${index + 1}: ยาวเกิน ${MAX_SCOPE_TEXT} ตัวอักษร`,
      );
      return;
    }
    lines.push(line);
  });
  if (lines.length > MAX_SCOPE_ITEMS) {
    problems.push(`${label}ได้ไม่เกิน ${MAX_SCOPE_ITEMS} ข้อ`);
  }
  return { lines, problems };
}

/**
 * Deliverables as a draft saves them. A deliverable with nothing in it is
 * dropped; one with criteria but no title is a problem, not silently lost.
 */
export function cleanDeliverables(
  input: readonly {
    title?: string;
    description?: string;
    criteria?: readonly (string | undefined)[];
  }[],
): { deliverables: Deliverable[]; problems: string[] } {
  const problems: string[] = [];
  const deliverables: Deliverable[] = [];
  input.forEach((entry, index) => {
    const title = entry.title?.trim() ?? '';
    const description = entry.description?.trim() ?? '';
    const where = `รายการส่งมอบข้อ ${index + 1}`;
    const criteria = cleanLines(entry.criteria ?? [], `${where} เกณฑ์ตรวจรับ`);
    if (!title && !description && !criteria.lines.length) return;
    if (!title) {
      problems.push(`${where}: ยังไม่มีชื่อรายการ`);
      return;
    }
    if (title.length > MAX_SCOPE_TEXT) {
      problems.push(`${where}: ชื่อยาวเกิน ${MAX_SCOPE_TEXT} ตัวอักษร`);
      return;
    }
    if (criteria.lines.length > MAX_CRITERIA) {
      problems.push(`${where}: เกณฑ์ตรวจรับได้ไม่เกิน ${MAX_CRITERIA} ข้อ`);
      return;
    }
    problems.push(...criteria.problems);
    deliverables.push({ title, description, criteria: criteria.lines });
  });
  if (deliverables.length > MAX_DELIVERABLES) {
    problems.push(`รายการส่งมอบได้ไม่เกิน ${MAX_DELIVERABLES} รายการ`);
  }
  return { deliverables, problems };
}

/**
 * Why the SOW stops a version from locking (user decision 29 ก.ย. 2569): the
 * locked version is what the contract (handoff 5) and the delivery checks
 * (handoff 8) are measured against, so it must say what is in scope and how
 * each deliverable is accepted. Out of scope is optional.
 */
export function sowGaps(version: {
  inScope: unknown;
  deliverables: unknown;
}): string[] {
  const gaps: string[] = [];
  if (!readLines(version.inScope).length) gaps.push('ยังไม่มีงานในขอบเขต');
  const deliverables = readDeliverables(version.deliverables);
  if (!deliverables.length) {
    gaps.push('ยังไม่มีรายการส่งมอบ');
  } else {
    const bare = deliverables.filter((item) => !item.criteria.length);
    if (bare.length) {
      gaps.push(
        `รายการส่งมอบยังไม่มีเกณฑ์ตรวจรับ: ${bare.map((item) => item.title).join(', ')}`,
      );
    }
  }
  return gaps;
}

// --- CD-143 approval -------------------------------------------------------------

export type SolutionApprovalStatus =
  'none' | 'pending' | 'approved' | 'rejected' | 'cancelled';

/**
 * Why this version cannot be sent for approval now, or null. Only the current
 * locked version goes — a draft is not fixed yet, a superseded one is no
 * longer what is offered — and not twice while a request is open or after it
 * was approved (a change is a new version, which starts over).
 */
/**
 * Items elsewhere on the Solution that keep a version from going for
 * approval — each a count of what is still open.
 */
export interface OpenApprovalItems {
  /** CD-140 — scope-affecting answers not yet worked into the SOW. */
  scopeUpdates?: number;
  /** CD-141 — open high/critical risks without an owner or a plan. */
  risksWithoutPlan?: number;
  /** CD-139 — Demo/POC findings the Solution must change for, still open. */
  demoFindings?: number;
  /** CD-138 — mandatory TOR clauses unanswered or answered "not comply". */
  torMandatoryGaps?: number;
}

export function approvalBlocker(
  version: {
    status: string;
    approvalStatus: SolutionApprovalStatus;
    feasibility?: FeasibilityVerdict;
  },
  isCurrent: boolean,
  open: OpenApprovalItems = {},
): string | null {
  const {
    scopeUpdates = 0,
    risksWithoutPlan = 0,
    demoFindings = 0,
    torMandatoryGaps = 0,
  } = open;
  if (version.status === 'draft') {
    return 'ยืนยันเวอร์ชันก่อน จึงขออนุมัติได้';
  }
  if (version.status !== 'locked' || !isCurrent) {
    return 'ขออนุมัติได้เฉพาะเวอร์ชันล่าสุดที่ยืนยันแล้ว';
  }
  if (version.approvalStatus === 'pending') {
    return 'เวอร์ชันนี้อยู่ระหว่างขออนุมัติแล้ว';
  }
  if (version.approvalStatus === 'approved') {
    return 'เวอร์ชันนี้อนุมัติแล้ว — ถ้าต้องแก้ให้เปิดเวอร์ชันใหม่';
  }
  // CD-140 — an answer that changed the scope must be in the SOW first.
  if (scopeUpdates > 0) {
    return `มีคำตอบที่กระทบขอบเขตยังไม่ได้แก้ SOW ${scopeUpdates} ข้อ`;
  }
  // CD-141 — a serious risk goes with someone on it and a plan.
  if (risksWithoutPlan > 0) {
    return `มีความเสี่ยงระดับสูง/วิกฤติที่ยังไม่มีผู้รับผิดชอบหรือแนวทางลด ${risksWithoutPlan} ข้อ`;
  }
  // CD-139 — what the demo showed must be in the design first.
  if (demoFindings > 0) {
    return `มีข้อค้นพบจาก Demo/POC ที่ต้องปรับ Solution ยังไม่ได้ปรับ ${demoFindings} ข้อ`;
  }
  // CD-138 — a mandatory TOR clause must be answered, and not with a no.
  if (torMandatoryGaps > 0) {
    return `ข้อบังคับของ TOR ยังไม่ครบ ${torMandatoryGaps} ข้อ (ยังไม่ตอบ หรือไม่เป็นไปตาม)`;
  }
  // CD-133 — a design judged not feasible is recorded, not offered.
  if (version.feasibility === 'not_feasible') {
    return 'เวอร์ชันนี้ประเมินว่าไม่เป็นไปได้ — ขออนุมัติไม่ได้';
  }
  return null;
}

const ASSESSMENT_LABELS: Record<RequirementAssessment, string> = {
  unassessed: 'ยังไม่ประเมิน',
  feasible: 'ทำได้',
  not_feasible: 'ทำไม่ได้',
  needs_info: 'ขอข้อมูลลูกค้า',
};

const numbered = (lines: readonly string[]) =>
  lines.map((line, index) => `${index + 1}. ${line}`).join('\n');

/**
 * The approval request's form, filled from the locked version so the
 * approver reads exactly what was fixed. Plain text: the request form is the
 * record of what was asked, and it must not change if the Solution does.
 */
export function approvalFormData(input: {
  title: string;
  versionNo: number;
  summary: string;
  inScope: unknown;
  outOfScope: unknown;
  deliverables: unknown;
  assumptions: unknown;
  feasibility?: FeasibilityVerdict;
  feasibilityNote?: string;
  requirements: readonly {
    kind: string;
    text: string;
    assessment: RequirementAssessment;
    note: string;
    customerAnswer: string | null;
  }[];
}): Record<string, string> {
  const deliverables = readDeliverables(input.deliverables)
    .map((item, index) =>
      [
        `${index + 1}. ${item.title}`,
        ...(item.description ? [`   ${item.description}`] : []),
        ...item.criteria.map((criterion) => `   - ตรวจรับ: ${criterion}`),
      ].join('\n'),
    )
    .join('\n');
  const assumptions = readAssumptions(input.assumptions)
    .map((item, index) => `${index + 1}. ${assumptionLine(item)}`)
    .join('\n');
  const requirements = input.requirements
    .map((item, index) =>
      [
        `${index + 1}. [${item.kind === 'business' ? 'ธุรกิจ' : 'เทคนิค'}] ${item.text} — ${ASSESSMENT_LABELS[item.assessment]}`,
        ...(item.note ? [`   ${item.note}`] : []),
        ...(item.customerAnswer
          ? [`   ลูกค้าตอบ: ${item.customerAnswer}`]
          : []),
      ].join('\n'),
    )
    .join('\n');
  const outOfScope = readLines(input.outOfScope);
  return {
    solution_title: input.title,
    version_no: String(input.versionNo),
    summary: input.summary,
    in_scope: numbered(readLines(input.inScope)),
    ...(outOfScope.length ? { out_of_scope: numbered(outOfScope) } : {}),
    deliverables,
    ...(assumptions ? { assumptions } : {}),
    ...(requirements ? { requirements } : {}),
    ...(input.feasibility && input.feasibility !== 'unassessed'
      ? {
          feasibility: [
            FEASIBILITY_LABELS[input.feasibility],
            input.feasibilityNote?.trim(),
          ]
            .filter(Boolean)
            .join(' — '),
        }
      : {}),
  };
}

// --- CD-140 technical clarifications --------------------------------------------

export interface ClarificationState {
  answer: string | null;
  affectsScope: boolean;
  scopeResolvedVersionNo: number | null;
}

/** Asked, not answered yet. */
export const awaitingAnswer = (row: ClarificationState) => !row.answer?.trim();

/** Answered in a way that changes scope, and the SOW not yet updated for it. */
export const scopeUpdateOpen = (row: ClarificationState) =>
  Boolean(row.answer?.trim()) &&
  row.affectsScope &&
  row.scopeResolvedVersionNo === null;

export function clarificationCounts(rows: readonly ClarificationState[]) {
  return {
    total: rows.length,
    awaiting_answer: rows.filter(awaitingAnswer).length,
    scope_open: rows.filter(scopeUpdateOpen).length,
  };
}

/**
 * Why this version cannot close a scope-affecting answer, or null. The SOW
 * that reflects an answer is one edited after it: a draft still being
 * written, or a version locked after the answer was recorded — never one
 * older than the version current when it was answered.
 */
export function scopeResolutionProblem(
  clarification: {
    answerRecordedAt: Date | null;
    answeredOnVersionNo: number | null;
  },
  version: { versionNo: number; status: string; lockedAt: Date | null },
): string | null {
  if (!clarification.answerRecordedAt) return 'ข้อนี้ยังไม่มีคำตอบ';
  if (version.versionNo < (clarification.answeredOnVersionNo ?? 0)) {
    return 'เวอร์ชันนี้เก่ากว่าตอนที่ได้คำตอบ — เลือกเวอร์ชันที่แก้ SOW หลังคำตอบ';
  }
  if (version.status === 'draft') return null;
  if (
    version.lockedAt &&
    version.lockedAt.getTime() > clarification.answerRecordedAt.getTime()
  ) {
    return null;
  }
  return 'เวอร์ชันนี้ยืนยันก่อนได้คำตอบ — แก้ SOW ในเวอร์ชันใหม่ก่อน';
}

/** The Q&A as text, for the approval request and the handover. */
export function clarificationsText(
  rows: readonly {
    seq: number;
    question: string;
    answer: string | null;
    respondent: string | null;
    answeredOn: Date | null;
    affectsScope: boolean;
  }[],
): string {
  return rows
    .map((row) =>
      [
        `${row.seq}. ถาม: ${row.question}`,
        row.answer
          ? `   ตอบ: ${row.answer}${
              row.respondent || row.answeredOn
                ? ` (${[
                    row.respondent,
                    row.answeredOn?.toISOString().slice(0, 10),
                  ]
                    .filter(Boolean)
                    .join(' · ')})`
                : ''
            }${row.affectsScope ? ' — กระทบขอบเขต' : ''}`
          : '   (ยังไม่ได้คำตอบ)',
      ].join('\n'),
    )
    .join('\n');
}

// --- CD-141 technical risks ------------------------------------------------------

export const RISK_STATUSES = [
  'open',
  'mitigated',
  'accepted',
  'closed',
] as const;
export type RiskStatus = (typeof RISK_STATUSES)[number];

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export const RISK_LEVEL_LABELS: Record<RiskLevel, string> = {
  low: 'ต่ำ',
  medium: 'ปานกลาง',
  high: 'สูง',
  critical: 'วิกฤติ',
};

/** Likelihood × impact, each 1–5. */
export const riskScore = (row: { likelihood: number; impact: number }) =>
  row.likelihood * row.impact;

/** 1–4 low · 5–9 medium · 10–16 high · 20–25 critical. */
export function riskLevel(score: number): RiskLevel {
  if (score >= 20) return 'critical';
  if (score >= 10) return 'high';
  if (score >= 5) return 'medium';
  return 'low';
}

export interface RiskState {
  likelihood: number;
  impact: number;
  owner: string;
  mitigation: string;
  status: RiskStatus;
}

/**
 * An open high or critical risk with nobody on it or no plan — the design
 * cannot go for approval with one (user decision 30 ก.ย. 2569).
 */
export const riskNeedsPlan = (row: RiskState) =>
  row.status === 'open' &&
  ['high', 'critical'].includes(riskLevel(riskScore(row))) &&
  (!row.owner.trim() || !row.mitigation.trim());

export function riskCounts(rows: readonly RiskState[]) {
  const open = rows.filter((row) => row.status === 'open');
  return {
    total: rows.length,
    open: open.length,
    open_high: open.filter((row) =>
      ['high', 'critical'].includes(riskLevel(riskScore(row))),
    ).length,
    needs_plan: rows.filter(riskNeedsPlan).length,
  };
}

/** The register as text, highest score first, for approval and handover. */
export function risksText(
  rows: readonly (RiskState & {
    seq: number;
    title: string;
    description: string;
  })[],
): string {
  const statusLabels: Record<RiskStatus, string> = {
    open: 'เปิด',
    mitigated: 'ลดแล้ว',
    accepted: 'ยอมรับ',
    closed: 'ปิด',
  };
  return [...rows]
    .sort((a, b) => riskScore(b) - riskScore(a) || a.seq - b.seq)
    .map((row) => {
      const score = riskScore(row);
      return [
        `${row.seq}. [${RISK_LEVEL_LABELS[riskLevel(score)]} ${score} = โอกาส ${row.likelihood} × ผลกระทบ ${row.impact} · ${statusLabels[row.status]}] ${row.title}`,
        ...(row.description ? [`   ${row.description}`] : []),
        ...(row.mitigation ? [`   แนวทางลด: ${row.mitigation}`] : []),
        ...(row.owner ? [`   ผู้รับผิดชอบ: ${row.owner}`] : []),
      ].join('\n');
    })
    .join('\n');
}

// --- CD-139 Demo / POC -----------------------------------------------------------

export const CRITERION_RESULTS = ['pending', 'met', 'not_met'] as const;
export type CriterionResult = (typeof CRITERION_RESULTS)[number];

export interface DemoCriterion {
  text: string;
  result: CriterionResult;
  note: string;
}

export const MAX_CRITERIA_PER_DEMO = 50;

/** A stored `criteria` column, read defensively. */
export function readCriteria(value: unknown): DemoCriterion[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const { text, result, note } = entry as Record<string, unknown>;
    if (typeof text !== 'string' || !text.trim()) return [];
    return [
      {
        text: text.trim(),
        result: (CRITERION_RESULTS as readonly unknown[]).includes(result)
          ? (result as CriterionResult)
          : 'pending',
        note: typeof note === 'string' ? note.trim() : '',
      },
    ];
  });
}

/**
 * Success criteria as saved: blank ones dropped. A result other than
 * `pending` must come with the criterion's text, like any other.
 */
export function cleanCriteria(
  input: readonly { text?: string; result?: string; note?: string }[],
): { criteria: DemoCriterion[]; problems: string[] } {
  const problems: string[] = [];
  const criteria = readCriteria(input);
  if (criteria.length > MAX_CRITERIA_PER_DEMO) {
    problems.push(`เกณฑ์ความสำเร็จได้ไม่เกิน ${MAX_CRITERIA_PER_DEMO} ข้อ`);
  }
  if (criteria.some((item) => item.text.length > 1000)) {
    problems.push('เกณฑ์ความสำเร็จยาวเกิน 1000 ตัวอักษร');
  }
  return { criteria, problems };
}

/** The request's success criteria (one per line) as the demo's starting list. */
export function criteriaFromText(text: unknown): DemoCriterion[] {
  if (typeof text !== 'string') return [];
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-•*]|\d+[.)])\s*/, '').trim())
    .filter(Boolean)
    .map((line) => ({ text: line, result: 'pending' as const, note: '' }));
}

/**
 * Why the demo cannot close as `done` or `cancelled` yet, or the gaps. Every
 * item taken out must be back either way; a demo that happened must say how
 * it went against each criterion.
 */
export function demoCloseGaps(
  target: 'done' | 'cancelled',
  demo: { criteria: unknown; outcome: string },
  equipment: readonly { name: string; returnedOn: Date | null }[],
): string[] {
  const gaps: string[] = [];
  const out = equipment.filter((item) => !item.returnedOn);
  if (out.length) {
    gaps.push(
      `ยังไม่คืนอุปกรณ์ ${out.length} รายการ: ${out.map((item) => item.name).join(', ')}`,
    );
  }
  if (target === 'done') {
    const pending = readCriteria(demo.criteria).filter(
      (item) => item.result === 'pending',
    );
    if (pending.length) {
      gaps.push(`ยังไม่ได้บันทึกผลตามเกณฑ์ ${pending.length} ข้อ`);
    }
    if (!demo.outcome.trim()) gaps.push('ยังไม่ได้สรุปผล');
  }
  return gaps;
}

export interface FindingState {
  requiresChange: boolean;
  resolvedVersionNo: number | null;
}

/** A finding the Solution must change for, not yet in a version. */
export const findingOpen = (row: FindingState) =>
  row.requiresChange && row.resolvedVersionNo === null;

export function demoCounts(
  demos: readonly {
    status: string;
    equipment: readonly { returnedOn: Date | null }[];
    findings: readonly FindingState[];
  }[],
) {
  return {
    total: demos.length,
    planned: demos.filter((demo) => demo.status === 'planned').length,
    equipment_out: demos.reduce(
      (sum, demo) =>
        sum + demo.equipment.filter((item) => !item.returnedOn).length,
      0,
    ),
    findings_open: demos.reduce(
      (sum, demo) => sum + demo.findings.filter(findingOpen).length,
      0,
    ),
  };
}

/** The demos as text, for the approval request and the handover. */
export function demosText(
  demos: readonly {
    seq: number;
    kind: string;
    title: string;
    status: string;
    scheduledOn: Date | null;
    criteria: unknown;
    outcome: string;
    findings: readonly {
      text: string;
      requiresChange: boolean;
      resolvedVersionNo: number | null;
    }[];
  }[],
): string {
  const results: Record<CriterionResult, string> = {
    pending: 'ยังไม่ได้ผล',
    met: 'ผ่าน',
    not_met: 'ไม่ผ่าน',
  };
  const statuses: Record<string, string> = {
    planned: 'วางแผน',
    done: 'จัดแล้ว',
    cancelled: 'ยกเลิก',
  };
  return demos
    .map((demo) =>
      [
        `${demo.seq}. [${demo.kind === 'poc' ? 'POC' : 'Demo'} · ${statuses[demo.status] ?? demo.status}${
          demo.scheduledOn
            ? ` · ${demo.scheduledOn.toISOString().slice(0, 10)}`
            : ''
        }] ${demo.title}`,
        ...readCriteria(demo.criteria).map(
          (item) =>
            `   - ${item.text}: ${results[item.result]}${item.note ? ` (${item.note})` : ''}`,
        ),
        ...(demo.outcome ? [`   สรุปผล: ${demo.outcome}`] : []),
        ...demo.findings.map(
          (finding) =>
            `   ข้อค้นพบ: ${finding.text}${
              finding.requiresChange
                ? finding.resolvedVersionNo !== null
                  ? ` (ปรับแล้วใน v${finding.resolvedVersionNo})`
                  : ' (ต้องปรับ Solution)'
                : ''
            }`,
        ),
      ].join('\n'),
    )
    .join('\n');
}

// --- CD-138 TOR / RFP --------------------------------------------------------------

export const TOR_COMPLIANCE = [
  'unanswered',
  'comply',
  'partial',
  'not_comply',
] as const;
export type TorCompliance = (typeof TOR_COMPLIANCE)[number];

export const TOR_COMPLIANCE_LABELS: Record<TorCompliance, string> = {
  unanswered: 'ยังไม่ตอบ',
  comply: 'เป็นไปตาม',
  partial: 'เป็นไปตามบางส่วน',
  not_comply: 'ไม่เป็นไปตาม',
};

export interface TorClauseState {
  mandatory: boolean;
  compliance: TorCompliance;
}

/**
 * A mandatory clause the offer cannot go out with (user decision 30 ก.ย.
 * 2569): not answered, or answered "not comply". "Partial" counts as
 * answered but is flagged.
 */
export const torMandatoryGap = (row: TorClauseState) =>
  row.mandatory &&
  (row.compliance === 'unanswered' || row.compliance === 'not_comply');

export function torCounts(rows: readonly TorClauseState[]) {
  const mandatory = rows.filter((row) => row.mandatory);
  return {
    total: rows.length,
    mandatory: mandatory.length,
    mandatory_answered: mandatory.filter(
      (row) => row.compliance === 'comply' || row.compliance === 'partial',
    ).length,
    mandatory_gaps: rows.filter(torMandatoryGap).length,
    partial: rows.filter((row) => row.compliance === 'partial').length,
    unanswered: rows.filter((row) => row.compliance === 'unanswered').length,
  };
}

/**
 * Clauses pasted from the TOR, one per line: a leading clause number
 * ("3.2.1", "ข้อ 4", "(ก)") is split off; "*" or "[บังคับ]" marks nothing
 * special — every clause starts mandatory and is unmarked by hand.
 */
export function clausesFromText(
  text: string,
): { clauseNo: string; text: string }[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match =
        /^(?:ข้อ\s*)?((?:\d+\.)*\d+\.?|\([ก-ฮa-z0-9]+\)|[ก-ฮ]\.)\s+(.+)$/i.exec(
          line,
        );
      return match
        ? { clauseNo: match[1].replace(/\.$/, ''), text: match[2].trim() }
        : { clauseNo: '', text: line };
    });
}

/** The TOR as text, for the approval request and the handover. */
export function torText(
  facts: {
    buyer: string;
    projectNo: string;
    submissionDeadline: Date | null;
    bidBond: string;
  } | null,
  clauses: readonly (TorClauseState & {
    seq: number;
    clauseNo: string;
    text: string;
    response: string;
    reference: string;
  })[],
): string {
  const head = facts
    ? [
        facts.buyer && `ผู้ซื้อ: ${facts.buyer}`,
        facts.projectNo && `เลขโครงการ: ${facts.projectNo}`,
        facts.submissionDeadline &&
          `กำหนดยื่น: ${facts.submissionDeadline.toISOString().slice(0, 16).replace('T', ' ')}`,
        facts.bidBond && `หลักประกันซอง: ${facts.bidBond}`,
      ].filter(Boolean)
    : [];
  const lines = clauses.map((row) =>
    [
      `${row.clauseNo || row.seq}. ${row.mandatory ? '[บังคับ] ' : ''}${row.text} — ${TOR_COMPLIANCE_LABELS[row.compliance]}`,
      ...(row.response ? [`   ตอบ: ${row.response}`] : []),
      ...(row.reference ? [`   อ้างอิง: ${row.reference}`] : []),
    ].join('\n'),
  );
  return [...head, ...lines].join('\n');
}
