/**
 * CD-191 ปิดโครงการ — the rules, apart from the database: what stops a
 * project from being closed, what is only worth a warning, and the lessons
 * it must leave behind.
 */

export const LESSON_KINDS = ['went_well', 'improve', 'recommend'] as const;
export type LessonKind = (typeof LESSON_KINDS)[number];

export const MAX_LESSON_LENGTH = 4000;
export const MAX_CLOSE_DOCUMENTS = 50;

/** What the close-out checks read, counted. */
export interface CloseFacts {
  projectStatus: string;
  /** Contract obligations (CD-163) still open. */
  obligationsOpen: number;
  /** Issues (CD-184) not resolved. */
  issuesOpen: number;
  /** Customer decisions on the scope not yet a change request (CD-186). */
  decisionsOwed: number;
  /** Change requests drafted or waiting for the board (CD-185). */
  changesPending: number;
  /** Milestones neither achieved nor cancelled (CD-182). */
  milestonesOpen: number;
  /** Required close-out documents with no file. */
  documentsMissing: string[];
  lessons: number;
  /** Warnings only. */
  tasksOpen: number;
  risksOpen: number;
  /** Amount of the installments not yet paid (CD-193). */
  outstanding: number;
}

export interface CloseCheck {
  key: string;
  label: string;
  ok: boolean;
  /** A failed blocking check stops the close; the others only warn. */
  blocking: boolean;
  detail: string | null;
}

const money = (value: number) =>
  value.toLocaleString('th-TH', { maximumFractionDigits: 2 });

/** Every check, passed or not, in the order the card lists them. */
export function closeChecks(facts: CloseFacts): CloseCheck[] {
  const count = (n: number, unit: string) => (n ? `ค้าง ${n} ${unit}` : null);
  return [
    {
      key: 'status',
      label: 'โครงการยังดำเนินอยู่',
      ok: facts.projectStatus === 'active' || facts.projectStatus === 'on_hold',
      blocking: true,
      detail:
        facts.projectStatus === 'active' || facts.projectStatus === 'on_hold'
          ? null
          : 'โครงการปิดหรือยกเลิกแล้ว',
    },
    {
      key: 'milestones',
      label: 'บรรลุทุก milestone',
      ok: facts.milestonesOpen === 0,
      blocking: true,
      detail: count(facts.milestonesOpen, 'milestone'),
    },
    {
      key: 'obligations',
      label: 'ไม่มีข้อผูกพันตามสัญญาค้าง',
      ok: facts.obligationsOpen === 0,
      blocking: true,
      detail: count(facts.obligationsOpen, 'ข้อ'),
    },
    {
      key: 'issues',
      label: 'แก้ปัญหาครบทุกข้อ',
      ok: facts.issuesOpen === 0,
      blocking: true,
      detail: count(facts.issuesOpen, 'ข้อ'),
    },
    {
      key: 'decisions',
      label: 'การตัดสินใจของลูกค้าที่กระทบขอบเขตแปลงเป็นคำขอเปลี่ยนแปลงครบ',
      ok: facts.decisionsOwed === 0,
      blocking: true,
      detail: count(facts.decisionsOwed, 'รายการ'),
    },
    {
      key: 'changes',
      label: 'ไม่มีคำขอเปลี่ยนแปลงค้าง (ร่างหรือรออนุมัติ)',
      ok: facts.changesPending === 0,
      blocking: true,
      detail: count(facts.changesPending, 'ใบ'),
    },
    {
      key: 'documents',
      label: 'แนบเอกสารปิดโครงการครบ',
      ok: facts.documentsMissing.length === 0,
      blocking: true,
      detail: facts.documentsMissing.length
        ? `ยังไม่มี: ${facts.documentsMissing.join(', ')}`
        : null,
    },
    {
      key: 'lessons',
      label: 'บันทึกบทเรียนอย่างน้อย 1 ข้อ',
      ok: facts.lessons > 0,
      blocking: true,
      detail: facts.lessons ? null : 'ยังไม่มีบทเรียน',
    },
    {
      key: 'tasks',
      label: 'งานในแผนเสร็จครบ',
      ok: facts.tasksOpen === 0,
      blocking: false,
      detail: count(facts.tasksOpen, 'งาน'),
    },
    {
      key: 'risks',
      label: 'ปิดความเสี่ยงครบ',
      ok: facts.risksOpen === 0,
      blocking: false,
      detail: count(facts.risksOpen, 'ข้อ'),
    },
    {
      key: 'payments',
      label: 'รับเงินครบทุกงวด',
      ok: facts.outstanding <= 0,
      blocking: false,
      detail:
        facts.outstanding > 0
          ? `ยังไม่ได้รับ ${money(facts.outstanding)} บาท`
          : null,
    },
  ];
}

/** What stops the close, in Thai — empty when it may be asked for. */
export function closeProblems(checks: readonly CloseCheck[]): string[] {
  return checks
    .filter((check) => check.blocking && !check.ok)
    .map((check) =>
      check.detail ? `${check.label}: ${check.detail}` : check.label,
    );
}

/** The required documents that have no file yet. */
export function missingDocuments(
  required: readonly string[],
  uploaded: readonly string[],
): string[] {
  const have = new Set(uploaded.map((title) => title.trim()));
  return required.filter((title) => !have.has(title.trim()));
}

/** A lesson's own problems, in Thai. */
export function lessonProblems(input: {
  kind: string;
  text: string;
}): string[] {
  const problems: string[] = [];
  if (!(LESSON_KINDS as readonly string[]).includes(input.kind)) {
    problems.push('ประเภทบทเรียนไม่ถูกต้อง');
  }
  const text = input.text.trim();
  if (!text) problems.push('ต้องระบุบทเรียน');
  if (text.length > MAX_LESSON_LENGTH) {
    problems.push(`บทเรียนยาวเกิน ${MAX_LESSON_LENGTH} ตัวอักษร`);
  }
  return problems;
}

/** May the close-out still be edited? Not while asked, nor once approved. */
export function closeoutEditable(status: string | null): boolean {
  return status === null || status === 'draft' || status === 'rejected';
}
