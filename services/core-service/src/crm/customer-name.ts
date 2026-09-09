/**
 * CM-03 — name normalization and similarity, pure functions.
 *
 * Pure so the dedup rules are testable without a database, the same reason
 * `access-rules.ts` is. The service persists `normalizedName` on every write
 * and compares against it; nothing here touches Prisma.
 */

/**
 * Legal-form noise the spec names (บจก./บมจ./หจก.) plus the long forms and
 * English equivalents they abbreviate. Longest first, so "ห้างหุ้นส่วนจำกัด"
 * is consumed before "จำกัด" can split it.
 *
 * These are *anywhere* in the name, not only a prefix: Thai names put the
 * form in front (บริษัท กขค จำกัด) with the closer at the end.
 */
const LEGAL_FORMS = [
  'บริษัทจำกัด (มหาชน)',
  'ห้างหุ้นส่วนสามัญนิติบุคคล',
  'ห้างหุ้นส่วนจำกัด',
  'ห้างหุ้นส่วนสามัญ',
  'จำกัด (มหาชน)',
  'จำกัด(มหาชน)',
  'บริษัท',
  'จำกัด',
  '(มหาชน)',
  'มหาชน',
  'บมจ.',
  'บจก.',
  'หจก.',
  'หสน.',
  'หสม.',
  'บจ.',
  'public company limited',
  'company limited',
  'corporation',
  'incorporated',
  'limited partnership',
  'limited',
  'co., ltd.',
  'co.,ltd.',
  'co. ltd.',
  'ltd.',
  'ltd',
  'inc.',
  'inc',
  'corp.',
  'corp',
  'pcl.',
  'pcl',
] as const;

/**
 * One comparable form of a customer name: legal forms stripped, lowercased,
 * every space and punctuation mark removed. "บริษัท กขค จำกัด" and "บจก.กขค"
 * both become "กขค", which is the whole point.
 */
export function normalizeCustomerName(name: string): string {
  let out = name.toLowerCase();

  for (const form of LEGAL_FORMS) {
    out = out.split(form).join(' ');
  }

  return out.replace(/[\s\p{P}]+/gu, '');
}

/**
 * Sørensen–Dice coefficient over character bigrams — 0 for nothing shared,
 * 1 for identical. Chosen over Levenshtein because it is length-insensitive:
 * "กขคเทรดดิ้ง" vs "กขค เทรดดิ้ง จำกัด" should score high, and an edit
 * distance normalized by the longer string does not.
 *
 * Multiset intersection (bigram counts, not a set), so repeated bigrams in
 * one name cannot inflate the score.
 */
export function nameSimilarity(a: string, b: string): number {
  if (a === b) return a.length ? 1 : 0;
  if (a.length < 2 || b.length < 2) return 0;

  const counts = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const bigram = a.slice(i, i + 2);
    counts.set(bigram, (counts.get(bigram) ?? 0) + 1);
  }

  let shared = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const bigram = b.slice(i, i + 2);
    const left = counts.get(bigram) ?? 0;
    if (left > 0) {
      counts.set(bigram, left - 1);
      shared++;
    }
  }

  return (2 * shared) / (a.length - 1 + (b.length - 1));
}

/**
 * CM-01 AC — เลขผู้เสียภาษี 13 หลัก checksum, the standard Thai national
 * id/tax id algorithm: the first 12 digits weighted 13 down to 2, summed,
 * and the check digit is `(11 − sum mod 11) mod 10`.
 */
export function isValidThaiTaxId(taxId: string): boolean {
  if (!/^\d{13}$/.test(taxId)) return false;

  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += Number(taxId[i]) * (13 - i);
  }

  return (11 - (sum % 11)) % 10 === Number(taxId[12]);
}
