/**
 * CD-132 — the rules of a Solution's versions, pure so they are tested on
 * their own.
 */
export const ASSUMPTION_CATEGORIES = [
  'technical',
  'customer',
  'third_party',
  'commercial',
] as const;
export type AssumptionCategory = (typeof ASSUMPTION_CATEGORIES)[number];

export const ASSUMPTION_CATEGORY_LABELS: Record<AssumptionCategory, string> = {
  technical: 'ทางเทคนิค',
  customer: 'สิ่งที่ต้องพึ่งพาลูกค้า',
  third_party: 'สิ่งที่ต้องพึ่งพาบุคคลที่สาม',
  commercial: 'เชิงพาณิชย์',
};

export interface Assumption {
  category: AssumptionCategory;
  text: string;
}

export const MAX_ASSUMPTIONS = 100;
export const MAX_ASSUMPTION_LENGTH = 1000;

/** What a stored `assumptions` column holds, read defensively. */
export function readAssumptions(value: unknown): Assumption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const { category, text } = entry as Record<string, unknown>;
    if (
      typeof text !== 'string' ||
      !text.trim() ||
      !(ASSUMPTION_CATEGORIES as readonly unknown[]).includes(category)
    ) {
      return [];
    }
    return [{ category: category as AssumptionCategory, text: text.trim() }];
  });
}

/**
 * Assumptions as a draft saves them: blank lines dropped, text trimmed.
 * Returns the problems instead of throwing so every one is named at once.
 */
export function cleanAssumptions(
  input: readonly { category?: string; text?: string }[],
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
    assumptions.push({ category: entry.category as AssumptionCategory, text });
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
}): string[] {
  const gaps: string[] = [];
  if (!version.summary.trim()) gaps.push('ยังไม่มีสรุปทางออก');
  if (!version.design.trim()) gaps.push('ยังไม่มีรายละเอียดการออกแบบ');
  return gaps;
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
