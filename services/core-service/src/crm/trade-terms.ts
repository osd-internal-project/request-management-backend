/**
 * CD-79 — comparing what was agreed against the company's standard terms.
 * Pure, so the rule the flag rests on is tested on its own.
 */
export interface StandardTerm {
  code: string;
  name: string;
  standardValue: string;
}

export interface AgreedTermInput {
  /** A standard term's code; absent = a term outside the list. */
  code?: string | null;
  /** Required for a term outside the list. */
  name?: string | null;
  agreed: string;
  note?: string | null;
}

export interface RecordedTerm {
  code: string | null;
  name: string;
  agreed: string;
  /** The standard as it stood on the day — null for a term outside the list. */
  standard: string | null;
  nonStandard: boolean;
  note: string | null;
}

/** Case, spacing and full/half-width spacing do not make a term different. */
export function normalizeTerm(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Each agreed term with its standard and whether it departs from it. A term
 * the list does not know is non-standard by definition — nobody has said
 * what normal looks like for it, which is exactly what Legal is for.
 * Returns problems instead of throwing so the caller can name them all.
 */
export function evaluateTerms(
  inputs: readonly AgreedTermInput[],
  standards: readonly StandardTerm[],
): { terms: RecordedTerm[]; problems: string[] } {
  const byCode = new Map(standards.map((term) => [term.code, term]));
  const problems: string[] = [];
  const seen = new Set<string>();
  const terms: RecordedTerm[] = [];

  inputs.forEach((input, index) => {
    const agreed = input.agreed?.trim() ?? '';
    const where = `เงื่อนไขที่ ${index + 1}`;
    if (!agreed) {
      problems.push(`${where}: ต้องระบุค่าที่ตกลง`);
      return;
    }
    const note = input.note?.trim() || null;

    if (input.code) {
      const standard = byCode.get(input.code);
      if (!standard) {
        problems.push(`${where}: ไม่รู้จักเงื่อนไขมาตรฐาน "${input.code}"`);
        return;
      }
      if (seen.has(input.code)) {
        problems.push(`${where}: "${standard.name}" ซ้ำในรอบเดียวกัน`);
        return;
      }
      seen.add(input.code);
      terms.push({
        code: standard.code,
        name: standard.name,
        agreed,
        standard: standard.standardValue,
        nonStandard:
          normalizeTerm(agreed) !== normalizeTerm(standard.standardValue),
        note,
      });
      return;
    }

    const name = input.name?.trim() ?? '';
    if (!name) {
      problems.push(`${where}: เงื่อนไขนอกรายการต้องมีชื่อ`);
      return;
    }
    terms.push({
      code: null,
      name,
      agreed,
      standard: null,
      nonStandard: true,
      note,
    });
  });

  if (!inputs.length) problems.push('ต้องมีเงื่อนไขอย่างน้อยหนึ่งรายการ');
  return { terms, problems };
}

/** The lines Legal reads: what was agreed, against what is normal. */
export function nonStandardLines(terms: readonly RecordedTerm[]): string {
  return terms
    .filter((term) => term.nonStandard)
    .map(
      (term) =>
        `• ${term.name}: ตกลง "${term.agreed}"` +
        (term.standard === null
          ? ' (ไม่มีในเงื่อนไขมาตรฐาน)'
          : ` (มาตรฐาน "${term.standard}")`) +
        (term.note ? ` — ${term.note}` : ''),
    )
    .join('\n');
}
