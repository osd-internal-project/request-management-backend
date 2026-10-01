/**
 * CD-221 ทดสอบ — the rules, apart from the database: what a project must
 * test (every line of the sold scope and every acceptance criterion of its
 * deliverables, from the baseline, plus what approved change requests
 * added), where each item stands, and what a result needs.
 */
import { readDeliverables, readLines } from '../presales/solution-rules';

export const TEST_RESULTS = ['pass', 'fail'] as const;
export type TestResult = (typeof TEST_RESULTS)[number];
export type TestState = 'untested' | 'passed' | 'failed' | 'waived';

export const MAX_TEST_TEXT = 2000;
export const MAX_TEST_NOTE = 4000;

/** An item the scope asks for, before it is a row. */
export interface TestSource {
  source: 'scope' | 'criterion' | 'change';
  sourceRef: string;
  deliverable: string | null;
  text: string;
}

/**
 * What the baseline and the approved changes say must be proved, in their
 * own order: scope lines, then each deliverable's criteria (a deliverable
 * with none is tested as a whole), then each approved change's added scope.
 * References are positions in the frozen baseline, so they never move.
 */
export function testSources(
  baseline: unknown,
  approvedChanges: readonly {
    id: string;
    seq: number;
    scopeAdded: string | null;
  }[],
): TestSource[] {
  const scope = (baseline as { scope?: Record<string, unknown> } | null)?.scope;
  const items: TestSource[] = readLines(scope?.inScope).map((text, index) => ({
    source: 'scope',
    sourceRef: `scope:${index}`,
    deliverable: null,
    text,
  }));
  readDeliverables(scope?.deliverables).forEach((deliverable, d) => {
    if (!deliverable.criteria.length) {
      items.push({
        source: 'criterion',
        sourceRef: `deliverable:${d}`,
        deliverable: deliverable.title,
        text: `ส่งมอบ ${deliverable.title}`,
      });
      return;
    }
    deliverable.criteria.forEach((criterion, c) =>
      items.push({
        source: 'criterion',
        sourceRef: `deliverable:${d}:${c}`,
        deliverable: deliverable.title,
        text: criterion,
      }),
    );
  });
  for (const change of approvedChanges) {
    const added = change.scopeAdded?.trim();
    if (!added) continue;
    items.push({
      source: 'change',
      sourceRef: `change:${change.id}`,
      deliverable: null,
      text: `CR-${change.seq}: ${added}`,
    });
  }
  return items;
}

/** Where an item stands: its latest run, unless waived. */
export function testState(item: {
  waivedAt: Date | string | null;
  runs: readonly { result: string }[];
}): TestState {
  if (item.waivedAt) return 'waived';
  const latest = item.runs[0];
  if (!latest) return 'untested';
  return latest.result === 'pass' ? 'passed' : 'failed';
}

export interface TestCoverage {
  total: number;
  passed: number;
  failed: number;
  untested: number;
  waived: number;
  /** Every item that applies has passed — handoff 8 may go ahead. */
  complete: boolean;
}

export function testCoverage(states: readonly TestState[]): TestCoverage {
  const count = (state: TestState) =>
    states.filter((item) => item === state).length;
  const passed = count('passed');
  const failed = count('failed');
  const untested = count('untested');
  const waived = count('waived');
  const total = states.length - waived;
  return {
    total,
    passed,
    failed,
    untested,
    waived,
    complete: total > 0 && passed === total,
  };
}

/** A result's own problems, in Thai: a fail says what failed, a pass shows it. */
export function resultProblems(input: {
  result: string;
  note: string;
  hasFile: boolean;
  waived: boolean;
}): string[] {
  const problems: string[] = [];
  if (input.waived)
    problems.push('ข้อนี้ถูกยกเว้นแล้ว — ยกเลิกการยกเว้นก่อนบันทึกผล');
  if (!(TEST_RESULTS as readonly string[]).includes(input.result)) {
    problems.push('ผลทดสอบต้องเป็นผ่านหรือไม่ผ่าน');
  }
  if (input.result === 'fail' && !input.note.trim()) {
    problems.push('ไม่ผ่าน: ต้องบอกว่าไม่ผ่านอย่างไร');
  }
  if (input.result === 'pass' && !input.hasFile) {
    problems.push('ผ่าน: ต้องแนบหลักฐาน (รูป ไฟล์ผลทดสอบ)');
  }
  if (input.note.length > MAX_TEST_NOTE) {
    problems.push(`บันทึกยาวเกิน ${MAX_TEST_NOTE} ตัวอักษร`);
  }
  return problems;
}

/** The issue a failed run opens, for the manager to see fixed. */
export function issueFromFailure(input: {
  label: string;
  text: string;
  note: string;
  tester: string;
}) {
  const title = `ไม่ผ่านทดสอบ ${input.label}: ${input.text}`;
  return {
    title: title.length > 255 ? `${title.slice(0, 252)}...` : title,
    description: `${input.note.trim()}\n— บันทึกโดย ${input.tester}`,
  };
}
