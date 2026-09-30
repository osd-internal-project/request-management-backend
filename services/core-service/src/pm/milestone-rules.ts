/**
 * CD-182 Milestone — the rules, apart from the database: what a milestone
 * must say to count as measurable, when it is achieved, and the first set
 * drawn from the billing schedule.
 */

export const MAX_CRITERIA = 20;
export const MAX_CRITERION_LENGTH = 500;
export const MAX_MILESTONES = 100;

export const MILESTONE_STATUSES = ['planned', 'achieved', 'cancelled'] as const;
export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];

export interface Criterion {
  text: string;
  met: boolean;
  metAt: string | null;
  metBy: string | null;
}

/** A stored criteria list, whatever it holds. */
export function readCriteria(value: unknown): Criterion[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (item): item is Record<string, unknown> =>
        typeof item === 'object' && item !== null,
    )
    .map((item) => ({
      text: typeof item.text === 'string' ? item.text : '',
      met: item.met === true,
      metAt: typeof item.metAt === 'string' ? item.metAt : null,
      metBy: typeof item.metBy === 'string' ? item.metBy : null,
    }))
    .filter((item) => item.text);
}

/**
 * New criteria texts over the old list: a text kept keeps its tick, a new
 * one starts unticked. Blanks and repeats are dropped.
 */
export function mergeCriteria(
  texts: readonly string[],
  previous: readonly Criterion[],
): Criterion[] {
  const seen = new Set<string>();
  const out: Criterion[] = [];
  for (const raw of texts) {
    const text = raw.trim().slice(0, MAX_CRITERION_LENGTH);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(
      previous.find((item) => item.text === text) ?? {
        text,
        met: false,
        metAt: null,
        metBy: null,
      },
    );
  }
  return out.slice(0, MAX_CRITERIA);
}

/**
 * What stops a milestone from being saved, in Thai. One that unlocks a
 * payment must say how it is measured — "ระบุงวดชำระที่ผูกกับ Milestone ที่
 * วัดได้จริง ไม่ใช่ระบุลอย ๆ".
 */
export function milestoneProblems(input: {
  title: string;
  criteria: readonly Criterion[];
  installmentId: string | null;
}): string[] {
  const problems: string[] = [];
  if (!input.title.trim()) problems.push('ต้องระบุชื่อหมุดหมาย');
  if (input.installmentId && !input.criteria.length) {
    problems.push(
      'หมุดหมายที่ผูกกับงวดชำระต้องมีเกณฑ์การบรรลุอย่างน้อยหนึ่งข้อ',
    );
  }
  return problems;
}

/**
 * What stops a milestone from being marked achieved: every criterion
 * ticked, evidence written, a day no later than today (Bangkok).
 */
export function achieveProblems(input: {
  status: string;
  criteria: readonly Criterion[];
  evidenceNote: string;
  achievedOn: string;
  today: string;
}): string[] {
  const problems: string[] = [];
  if (input.status !== 'planned') {
    problems.push('หมุดหมายนี้บรรลุหรือยกเลิกไปแล้ว');
  }
  if (!input.criteria.length) {
    problems.push('ยังไม่มีเกณฑ์การบรรลุ — เพิ่มเกณฑ์ก่อน');
  }
  const open = input.criteria.filter((item) => !item.met).length;
  if (open) problems.push(`ยังมีเกณฑ์ที่ไม่ได้ยืนยัน ${open} ข้อ`);
  if (!input.evidenceNote.trim()) problems.push('ต้องบันทึกหลักฐานการบรรลุ');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.achievedOn)) {
    problems.push('วันที่บรรลุไม่ถูกต้อง');
  } else if (input.achievedOn > input.today) {
    problems.push('วันที่บรรลุต้องไม่เกินวันนี้');
  }
  return problems;
}

export interface ScheduleRow {
  id: string;
  seq: number;
  kind: string;
  label: string;
  dueOn: Date | null;
  milestone: string | null;
}

export interface DeliverableLike {
  title: string;
  criteria?: string[];
}

const norm = (value: string) => value.toLowerCase().replace(/\s+/g, '');

/** The deliverable a milestone name speaks of, if one matches. */
export function matchDeliverable(
  name: string,
  deliverables: readonly DeliverableLike[],
): DeliverableLike | null {
  const key = norm(name);
  if (!key) return null;
  return (
    deliverables.find((item) => norm(item.title) === key) ??
    deliverables.find((item) => {
      const title = norm(item.title);
      return title.length > 1 && (key.includes(title) || title.includes(key));
    }) ??
    null
  );
}

/**
 * The first milestones, from the billing schedule: one per installment that
 * waits on work (it names a milestone, or is a progress or final payment)
 * and is not yet tied to one. The deposit, paid on signing, and retention,
 * paid after warranty, wait on no project work. Criteria come from the
 * matching deliverable's acceptance criteria.
 */
export function milestonesFromSchedule(
  schedule: readonly ScheduleRow[],
  deliverables: readonly DeliverableLike[],
  linked: ReadonlySet<string>,
) {
  return schedule
    .filter(
      (row) =>
        !linked.has(row.id) &&
        (Boolean(row.milestone?.trim()) ||
          row.kind === 'progress' ||
          row.kind === 'final'),
    )
    .map((row) => {
      const title = row.milestone?.trim() || row.label;
      const deliverable = matchDeliverable(title, deliverables);
      return {
        title,
        installmentId: row.id,
        dueOn: row.dueOn,
        criteria: mergeCriteria(deliverable?.criteria ?? [], []),
      };
    });
}
