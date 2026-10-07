/**
 * CD-290 — how ready a swept business is for a salesperson, as a number
 * anyone can recompute: each rule adds points and says why. The model's
 * summary (when a real gateway is on) explains; it never sets the number.
 */

export interface ScoreReason {
  /** Thai, shown as-is in the review queue. */
  label: string;
  points: number;
}

export interface Scorable {
  taxId: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  industry: string | null;
  province: string | null;
  registeredCapital: number | null;
}

export interface ScoringCriteria {
  keywords?: string[];
  industries?: string[];
  provinces?: string[];
}

/** What CRM already holds about it. */
export type MatchKind = 'customer' | 'lead' | 'none';

/** Below this, a row is shown but marked weak in the queue. */
export const WEAK_SCORE = 40;

const contains = (haystack: string | null, needles: string[] | undefined) =>
  !!haystack &&
  !!needles?.length &&
  needles.some((needle) =>
    haystack.toLowerCase().includes(needle.trim().toLowerCase()),
  );

export function scoreProspect(
  row: Scorable,
  criteria: ScoringCriteria,
  match: MatchKind,
): { score: number; reasons: ScoreReason[] } {
  const reasons: ScoreReason[] = [];
  const add = (label: string, points: number) =>
    reasons.push({ label, points });

  if (row.taxId) add('มีเลขนิติบุคคล — ตรวจสอบตัวตนได้', 20);
  if (row.phone) add('มีเบอร์โทร — ติดต่อได้ทันที', 15);
  if (row.email) add('มีอีเมล', 10);
  if (row.website) add('มีเว็บไซต์', 5);

  const capital = row.registeredCapital;
  if (capital !== null) {
    if (capital >= 50_000_000) add('ทุนจดทะเบียน ≥ 50 ล้านบาท', 20);
    else if (capital >= 10_000_000) add('ทุนจดทะเบียน ≥ 10 ล้านบาท', 15);
    else if (capital >= 1_000_000) add('ทุนจดทะเบียน ≥ 1 ล้านบาท', 10);
  }

  if (
    contains(row.industry, [
      ...(criteria.industries ?? []),
      ...(criteria.keywords ?? []),
    ])
  ) {
    add('ประเภทธุรกิจตรงกับที่ค้นหา', 15);
  }
  if (contains(row.province, criteria.provinces)) {
    add('อยู่ในจังหวัดเป้าหมาย', 15);
  }

  if (match === 'lead') add('มี Lead ที่ยังเปิดอยู่ใน CRM แล้ว', -40);
  if (match === 'customer') {
    add('เป็นลูกค้าเดิม — ส่งถึงผู้ดูแลบัญชี (Keeper)', 0);
  }

  const total = reasons.reduce((sum, reason) => sum + reason.points, 0);
  return { score: Math.max(0, Math.min(100, total)), reasons };
}
