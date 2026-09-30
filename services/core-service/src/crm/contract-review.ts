/**
 * CD-147 ตรวจสัญญา — comparing two versions of a draft, and the rules on
 * review comments, apart from the database.
 */
import { sameText, type Clause } from './contract-drafts';

export type DiffOp = { type: 'same' | 'add' | 'del'; text: string };

/** Longest-common-subsequence table walk over two token lists. */
function lcs<T>(a: readonly T[], b: readonly T[]): DiffOp[] | null {
  const n = a.length;
  const m = b.length;
  // too large to walk cell by cell: the caller falls back to replace
  if (n * m > 4_000_000) return null;
  const table: Uint32Array[] = Array.from(
    { length: n + 1 },
    () => new Uint32Array(m + 1),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] =
        a[i] === b[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'same', text: String(a[i]) });
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push({ type: 'del', text: String(a[i++]) });
    } else {
      ops.push({ type: 'add', text: String(b[j++]) });
    }
  }
  while (i < n) ops.push({ type: 'del', text: String(a[i++]) });
  while (j < m) ops.push({ type: 'add', text: String(b[j++]) });
  return ops;
}

/** Adjacent pieces of the same kind as one. */
function merge(ops: DiffOp[]): DiffOp[] {
  const out: DiffOp[] = [];
  for (const op of ops) {
    const last = out[out.length - 1];
    if (last && last.type === op.type) last.text += op.text;
    else if (op.text) out.push({ ...op });
  }
  return out;
}

/**
 * What changed from `before` to `after`: by line first, then — for a run of
 * lines taken out and put back — by character, since Thai has no spaces
 * between words to diff on.
 */
export function diffText(before: string, after: string): DiffOp[] {
  if (before === after) return before ? [{ type: 'same', text: before }] : [];
  const lines = (text: string) => text.replace(/\r\n/g, '\n').split(/(?<=\n)/);
  const byLine = lcs(lines(before), lines(after));
  if (!byLine) {
    return merge([
      { type: 'del', text: before },
      { type: 'add', text: after },
    ]);
  }
  const out: DiffOp[] = [];
  let removed = '';
  let added = '';
  const flush = () => {
    if (removed && added) {
      const byChar = lcs([...removed], [...added]);
      out.push(
        ...(byChar ?? [
          { type: 'del' as const, text: removed },
          { type: 'add' as const, text: added },
        ]),
      );
    } else {
      if (removed) out.push({ type: 'del', text: removed });
      if (added) out.push({ type: 'add', text: added });
    }
    removed = '';
    added = '';
  };
  for (const op of byLine) {
    if (op.type === 'del') removed += op.text;
    else if (op.type === 'add') added += op.text;
    else {
      flush();
      out.push(op);
    }
  }
  flush();
  return merge(out);
}

export type ClauseChange = 'same' | 'changed' | 'added' | 'removed';

/**
 * Two versions side by side, clause by clause (matched on the clause key):
 * the later version's order, with clauses it no longer has at the end.
 */
export function compareVersions(
  from: readonly Clause[],
  to: readonly Clause[],
): {
  key: string;
  heading: string;
  change: ClauseChange;
  moved: boolean;
  headingBefore: string | null;
  diff: DiffOp[];
}[] {
  const before = new Map(
    from.map((clause, index) => [clause.key, { clause, index }]),
  );
  const keptKeys = to
    .filter((clause) => before.has(clause.key))
    .map((c) => c.key);
  const oldOrder = from
    .filter((c) => keptKeys.includes(c.key))
    .map((c) => c.key);
  const rows = to.map((clause) => {
    const old = before.get(clause.key);
    if (!old) {
      return {
        key: clause.key,
        heading: clause.heading,
        change: 'added' as const,
        moved: false,
        headingBefore: null,
        diff: diffText('', clause.body),
      };
    }
    const same =
      sameText(old.clause.body, clause.body) &&
      sameText(old.clause.heading, clause.heading);
    return {
      key: clause.key,
      heading: clause.heading,
      change: same ? ('same' as const) : ('changed' as const),
      moved: oldOrder.indexOf(clause.key) !== keptKeys.indexOf(clause.key),
      headingBefore: sameText(old.clause.heading, clause.heading)
        ? null
        : old.clause.heading,
      diff: diffText(old.clause.body, clause.body),
    };
  });
  const keys = new Set(to.map((clause) => clause.key));
  const gone = from
    .filter((clause) => !keys.has(clause.key))
    .map((clause) => ({
      key: clause.key,
      heading: clause.heading,
      change: 'removed' as const,
      moved: false,
      headingBefore: null,
      diff: diffText(clause.body, ''),
    }));
  return [...rows, ...gone];
}

/** Has the clause changed between two versions (or gone)? */
export function clauseChanged(
  key: string,
  from: readonly Clause[],
  to: readonly Clause[],
): boolean {
  const a = from.find((clause) => clause.key === key);
  const b = to.find((clause) => clause.key === key);
  if (!a) return false;
  // taken out since: that is a change too
  if (!b) return true;
  return !sameText(a.body, b.body) || !sameText(a.heading, b.heading);
}

/** Why a comment's answer cannot be saved, or null. */
export function answerProblem(
  status: string,
  response: string | undefined,
): string | null {
  if (status !== 'resolved' && status !== 'declined') {
    return 'ตอบได้เป็น แก้แล้ว หรือ ไม่แก้ เท่านั้น';
  }
  if (status === 'declined' && !response?.trim()) {
    return 'ไม่แก้ต้องให้เหตุผล';
  }
  return null;
}
