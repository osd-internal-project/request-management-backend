/**
 * CD-150 ตรวจขอบเขตงาน — comparing the scope of work a contract request
 * brought (CD-145) with the draft's text, apart from the database.
 */
import type { Clause } from './contract-drafts';

export type ScopeKind =
  'in_scope' | 'out_of_scope' | 'deliverable' | 'criterion';

export interface ScopeItem {
  /** Stable within a package: kind + position. */
  key: string;
  kind: ScopeKind;
  text: string;
  /** For a criterion, the deliverable it belongs to. */
  parent?: string;
}

export interface CheckedItem extends ScopeItem {
  found: boolean;
  verdict: 'match' | 'mismatch' | null;
  note: string | null;
}

/** Every item the contract has to carry, in reading order. */
export function scopeItems(pack: {
  inScope: string[];
  outOfScope: string[];
  deliverables: { title: string; criteria?: string[] }[];
}): ScopeItem[] {
  const items: ScopeItem[] = [];
  pack.inScope.forEach((text, index) =>
    items.push({ key: `in-${index}`, kind: 'in_scope', text }),
  );
  pack.outOfScope.forEach((text, index) =>
    items.push({ key: `out-${index}`, kind: 'out_of_scope', text }),
  );
  pack.deliverables.forEach((deliverable, index) => {
    items.push({
      key: `del-${index}`,
      kind: 'deliverable',
      text: deliverable.title,
    });
    (deliverable.criteria ?? []).forEach((criterion, at) =>
      items.push({
        key: `del-${index}-${at}`,
        kind: 'criterion',
        text: criterion,
        parent: deliverable.title,
      }),
    );
  });
  return items.filter((item) => item.text.trim());
}

/** Spacing, case and punctuation do not make a scope item different. */
// zero-width space: Thai text copied from documents often carries it
const ZERO_WIDTH = new RegExp(String.fromCharCode(0x200b), 'g');
const squash = (text: string) =>
  text
    .toLowerCase()
    .replace(ZERO_WIDTH, '')
    .replace(/[\s.,;:()"'“”‘’\-–—/]+/g, '');

/** Is the item's text in the contract's text? */
export function foundIn(item: ScopeItem, clauses: readonly Clause[]): boolean {
  const needle = squash(item.text);
  if (!needle) return true;
  const haystack = squash(
    clauses.map((clause) => `${clause.heading}\n${clause.body}`).join('\n'),
  );
  return haystack.includes(needle);
}

/**
 * The items against the text, with Legal's verdicts: found means it matches
 * unless Legal said otherwise; not found needs Legal's verdict.
 */
export function checkItems(
  items: readonly ScopeItem[],
  clauses: readonly Clause[],
  verdicts: ReadonlyMap<
    string,
    { verdict: 'match' | 'mismatch'; note: string | null }
  >,
): CheckedItem[] {
  return items.map((item) => {
    const found = foundIn(item, clauses);
    const given = verdicts.get(item.key);
    return {
      ...item,
      found,
      verdict: given?.verdict ?? (found ? 'match' : null),
      note: given?.note ?? null,
    };
  });
}

/** What stops a check from being saved, in Thai. */
export function checkProblems(items: readonly CheckedItem[]): string[] {
  const problems: string[] = [];
  for (const item of items) {
    if (!item.verdict) {
      problems.push(`ยังไม่ได้ตัดสิน: ${item.text}`);
    } else if (item.verdict === 'mismatch' && !item.note?.trim()) {
      problems.push(`ไม่สอดคล้องต้องระบุจุดที่ไม่ตรง: ${item.text}`);
    } else if (!item.found && item.verdict === 'match' && !item.note?.trim()) {
      problems.push(
        `ไม่พบในสัญญาแต่ถือว่าตรง ต้องอธิบาย (เช่น ข้อที่ใช้ถ้อยคำอื่น): ${item.text}`,
      );
    }
  }
  return problems;
}

export function statusOf(
  items: readonly CheckedItem[],
): 'consistent' | 'inconsistent' {
  return items.every((item) => item.verdict === 'match')
    ? 'consistent'
    : 'inconsistent';
}
