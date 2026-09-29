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
export function approvalBlocker(
  version: {
    status: string;
    approvalStatus: SolutionApprovalStatus;
    feasibility?: FeasibilityVerdict;
  },
  isCurrent: boolean,
): string | null {
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
