/**
 * CD-212 แผนงานพัฒนาซอฟต์แวร์ — the rules, apart from the database: the
 * SOW lines software work is broken into, and where the plan covers them.
 */
import { readDeliverables, readLines } from '../presales/solution-rules';

export const DEV_KINDS = ['iteration', 'item'] as const;
export type DevKind = (typeof DEV_KINDS)[number];
export const MAX_ITEMS_PER_CALL = 50;

/** A line of the SOW development delivers. */
export interface DevSource {
  ref: string;
  source: 'scope' | 'deliverable' | 'change';
  text: string;
}

/**
 * The SOW in its own order: scope lines, deliverables (as a whole), then
 * what approved change requests added. References are positions in the
 * frozen baseline, so they never move.
 */
export function devSources(
  baseline: unknown,
  approvedChanges: readonly {
    id: string;
    seq: number;
    scopeAdded: string | null;
  }[],
): DevSource[] {
  const scope = (baseline as { scope?: Record<string, unknown> } | null)?.scope;
  const items: DevSource[] = readLines(scope?.inScope).map((text, index) => ({
    ref: `scope:${index}`,
    source: 'scope',
    text,
  }));
  readDeliverables(scope?.deliverables).forEach((deliverable, d) =>
    items.push({
      ref: `deliverable:${d}`,
      source: 'deliverable',
      text: `ส่งมอบ ${deliverable.title}`,
    }),
  );
  for (const change of approvedChanges) {
    const added = change.scopeAdded?.trim();
    if (!added) continue;
    items.push({
      ref: `change:${change.id}`,
      source: 'change',
      text: `CR-${change.seq}: ${added}`,
    });
  }
  return items;
}

/** The title a development item takes in the plan. */
export function itemTitle(text: string) {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > 255 ? `${clean.slice(0, 252)}...` : clean;
}

/**
 * Where the plan covers the SOW: the lines no live development item
 * delivers yet, and the share that are planned and done.
 */
export function coverage(
  sources: readonly DevSource[],
  items: readonly { sowRef: string | null; status: string }[],
) {
  const live = items.filter((item) => item.status !== 'cancelled');
  const planned = new Set(live.map((item) => item.sowRef));
  const done = new Set(
    live.filter((item) => item.status === 'done').map((item) => item.sowRef),
  );
  return {
    total: sources.length,
    planned: sources.filter((row) => planned.has(row.ref)).length,
    done: sources.filter((row) => done.has(row.ref)).length,
    unplanned: sources.filter((row) => !planned.has(row.ref)),
  };
}

/** Problems with adding SOW lines to an iteration, in Thai. */
export function addProblems(input: {
  refs: readonly string[];
  sources: readonly DevSource[];
  planned: ReadonlySet<string>;
}): string[] {
  const problems: string[] = [];
  if (!input.refs.length) problems.push('ต้องเลือกข้อ SOW อย่างน้อยหนึ่งข้อ');
  if (input.refs.length > MAX_ITEMS_PER_CALL) {
    problems.push(`เพิ่มได้ครั้งละไม่เกิน ${MAX_ITEMS_PER_CALL} ข้อ`);
  }
  if (new Set(input.refs).size !== input.refs.length) {
    problems.push('เลือกข้อ SOW ซ้ำ');
  }
  const known = new Set(input.sources.map((row) => row.ref));
  const unknown = input.refs.filter((ref) => !known.has(ref));
  if (unknown.length) problems.push(`ไม่พบข้อ SOW: ${unknown.join(', ')}`);
  const taken = input.refs.filter((ref) => input.planned.has(ref));
  if (taken.length) {
    problems.push(`ข้อ SOW นี้อยู่ในรอบงานแล้ว: ${taken.join(', ')}`);
  }
  return problems;
}
