/**
 * CD-146 ร่างสัญญา — the rules on templates and drafts, apart from the
 * database: which variables exist, how a clause is filled, and how a
 * version's clauses compare with the template they came from.
 */

export interface Clause {
  key: string;
  heading: string;
  body: string;
}

/**
 * The variables a template may use. Negotiated terms (CD-79) add one per
 * term code as `term_<code>`, so those are accepted by pattern.
 */
export const DRAFT_VARIABLES: Record<string, string> = {
  today: 'วันที่วันนี้',
  request_no: 'เลขที่คำขอจัดทำสัญญา',
  our_name: 'ชื่อบริษัทเรา (หัวกระดาษ)',
  our_tax_id: 'เลขผู้เสียภาษีบริษัทเรา',
  our_address: 'ที่อยู่บริษัทเรา',
  party_name: 'ชื่อคู่สัญญา',
  party_tax_id: 'เลขผู้เสียภาษีคู่สัญญา',
  party_branch: 'สาขาคู่สัญญา',
  party_address: 'ที่อยู่คู่สัญญา',
  deal_code: 'รหัสโอกาสการขาย',
  deal_title: 'ชื่อดีล',
  contract_value: 'มูลค่าสัญญา',
  currency: 'สกุลเงิน',
  start_date: 'วันเริ่มสัญญา',
  end_date: 'วันสิ้นสุดสัญญา',
  trade_terms: 'เงื่อนไขการค้าที่ตกลง (ทุกข้อ)',
  scope_of_work: 'งานในขอบเขต (จาก Solution ที่อนุมัติ)',
  out_of_scope: 'งานนอกขอบเขต',
  deliverables: 'รายการส่งมอบและเกณฑ์ตรวจรับ',
  assumptions: 'สมมติฐานและสิ่งที่ต้องพึ่งพา',
};

const VARIABLE = /\{\{\s*([a-z0-9_]+)\s*\}\}/g;
const TERM_VARIABLE = /^term_[a-z0-9_]+$/;

export const MAX_CLAUSES = 200;
export const MAX_BODY = 20_000;

export function isKnownVariable(name: string): boolean {
  return name in DRAFT_VARIABLES || TERM_VARIABLE.test(name);
}

/** `term_<code>` for a negotiated term's code: lower case, `_` for the rest. */
export function termVariable(code: string): string {
  return `term_${code.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
}

/**
 * Fill the variables that have a value. One without stays as `{{name}}` so
 * Legal sees in the draft what still has to be written in.
 */
export function fill(
  text: string,
  values: Record<string, string>,
): { text: string; missing: string[] } {
  const missing = new Set<string>();
  const filled = text.replace(VARIABLE, (whole, name: string) => {
    const value = values[name];
    if (value === undefined || value === '') {
      missing.add(name);
      return whole;
    }
    return value;
  });
  return { text: filled, missing: [...missing] };
}

/** What stops a template from being saved, in Thai. */
export function templateProblems(clauses: readonly Clause[]): string[] {
  const problems: string[] = [];
  if (!clauses.length) problems.push('แม่แบบต้องมีอย่างน้อยหนึ่งข้อ');
  if (clauses.length > MAX_CLAUSES) {
    problems.push(`แม่แบบมีได้ไม่เกิน ${MAX_CLAUSES} ข้อ`);
  }
  const keys = new Set<string>();
  const unknown = new Set<string>();
  clauses.forEach((clause, index) => {
    const n = `ข้อ ${index + 1}`;
    if (!clause.heading.trim()) problems.push(`${n}: ต้องมีหัวข้อ`);
    if (!clause.body.trim()) problems.push(`${n}: ต้องมีเนื้อความ`);
    if (clause.body.length > MAX_BODY) {
      problems.push(`${n}: เนื้อความยาวเกิน ${MAX_BODY} ตัวอักษร`);
    }
    if (keys.has(clause.key)) problems.push(`${n}: รหัสข้อซ้ำ`);
    keys.add(clause.key);
    for (const match of `${clause.heading}\n${clause.body}`.matchAll(
      VARIABLE,
    )) {
      if (!isKnownVariable(match[1])) unknown.add(match[1]);
    }
  });
  if (unknown.size) {
    problems.push(
      `ไม่รู้จักตัวแปร ${[...unknown].map((name) => `{{${name}}}`).join(', ')}`,
    );
  }
  return problems;
}

/** What stops a version from being saved, in Thai. */
export function versionProblems(clauses: readonly Clause[]): string[] {
  const problems: string[] = [];
  if (!clauses.length) problems.push('ร่างต้องมีอย่างน้อยหนึ่งข้อ');
  if (clauses.length > MAX_CLAUSES) {
    problems.push(`ร่างมีได้ไม่เกิน ${MAX_CLAUSES} ข้อ`);
  }
  const keys = new Set<string>();
  clauses.forEach((clause, index) => {
    const n = `ข้อ ${index + 1}`;
    if (!clause.heading.trim()) problems.push(`${n}: ต้องมีหัวข้อ`);
    if (clause.body.length > MAX_BODY) {
      problems.push(`${n}: เนื้อความยาวเกิน ${MAX_BODY} ตัวอักษร`);
    }
    if (keys.has(clause.key)) problems.push(`${n}: รหัสข้อซ้ำ`);
    keys.add(clause.key);
  });
  return problems;
}

/** Line endings and trailing spaces do not make a clause different. */
export function sameText(a: string, b: string): boolean {
  const norm = (text: string) =>
    text
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((line) => line.trimEnd())
      .join('\n')
      .trim();
  return norm(a) === norm(b);
}

export type ClauseMark = 'template' | 'edited' | 'added';

/**
 * How each clause of a version stands against the template it came from:
 * as the template filled it, edited, or added; and the template's clauses
 * that were taken out.
 */
export function markClauses(
  clauses: readonly Clause[],
  template: readonly Clause[],
): {
  clauses: (Clause & { mark: ClauseMark; templateBody: string | null })[];
  removed: Clause[];
} {
  const byKey = new Map(template.map((clause) => [clause.key, clause]));
  const kept = new Set<string>();
  const marked = clauses.map((clause) => {
    const origin = byKey.get(clause.key);
    if (!origin)
      return { ...clause, mark: 'added' as const, templateBody: null };
    kept.add(clause.key);
    const same =
      sameText(origin.body, clause.body) &&
      sameText(origin.heading, clause.heading);
    return {
      ...clause,
      mark: same ? ('template' as const) : ('edited' as const),
      templateBody: origin.body,
    };
  });
  return {
    clauses: marked,
    removed: template.filter((clause) => !kept.has(clause.key)),
  };
}

/** Two versions hold the same text, clause by clause. */
export function sameClauses(
  a: readonly Clause[],
  b: readonly Clause[],
): boolean {
  return (
    a.length === b.length &&
    a.every(
      (clause, index) =>
        clause.key === b[index].key &&
        sameText(clause.heading, b[index].heading) &&
        sameText(clause.body, b[index].body),
    )
  );
}

export function readClauses(value: unknown): Clause[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (row): row is Clause =>
        typeof row === 'object' &&
        row !== null &&
        typeof (row as Clause).key === 'string',
    )
    .map((row) => ({
      key: row.key,
      heading: typeof row.heading === 'string' ? row.heading : '',
      body: typeof row.body === 'string' ? row.body : '',
    }));
}
