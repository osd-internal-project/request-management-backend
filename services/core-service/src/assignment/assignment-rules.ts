/**
 * ตารางทีม (เส้นทาง Lead ถึงบริการ Phase 0, 2 พ.ย. 2569) — the pure half:
 * which rule a piece of work matches, and who in the team gets it.
 *
 * source (ผู้ใช้ 28 ต.ค.): Sale, Pre-Sales, Pricing, กฎหมาย, PM ใช้วิธีเดียวกัน —
 * ตารางทีมในหน้า admin, งานน้อยสุดก่อน เท่ากันวนคิว, ไม่ตรงเงื่อนไขส่งหัวหน้า,
 * ตัดคนที่ลาอยู่ออกก่อนเลือก. Support ใช้ตารางเดียวกันในเวลาทำการ (ช่วงที่ 6).
 */

export interface AssignmentRoleSpec {
  label: string;
  /** Criteria a rule may test; the caller sends the same keys. */
  fields: { key: string; label: string }[];
}

/** proposed — the fields each role is routed by; a rule may use any subset. */
export const ASSIGNMENT_ROLES: Readonly<Record<string, AssignmentRoleSpec>> = {
  sales: {
    label: 'พนักงานขาย',
    fields: [
      { key: 'customerType', label: 'ประเภทลูกค้า' },
      { key: 'industry', label: 'อุตสาหกรรม' },
      { key: 'productGroup', label: 'กลุ่มบริการ' },
      { key: 'companySize', label: 'ขนาดบริษัท' },
      { key: 'province', label: 'จังหวัด' },
    ],
  },
  presales: {
    label: 'Pre-Sales',
    fields: [
      { key: 'productGroup', label: 'กลุ่มบริการ' },
      { key: 'mode', label: 'ทบทวน / ออกแบบใหม่' },
    ],
  },
  pricing: {
    label: 'Pricing',
    fields: [{ key: 'productGroup', label: 'กลุ่มบริการ' }],
  },
  legal: {
    label: 'ฝ่ายกฎหมาย',
    fields: [{ key: 'contractKind', label: 'ชนิดสัญญา' }],
  },
  pm: {
    label: 'ผู้จัดการโครงการ',
    fields: [
      { key: 'workType', label: 'ประเภทงาน' },
      { key: 'productGroup', label: 'กลุ่มบริการ' },
    ],
  },
  support: {
    label: 'Support',
    fields: [
      { key: 'productGroup', label: 'กลุ่มบริการ' },
      { key: 'severity', label: 'ความรุนแรง' },
    ],
  },
};

export const ASSIGNMENT_ROLE_KEYS = Object.keys(ASSIGNMENT_ROLES);

export type Conditions = Record<string, string[]>;
export type Criteria = Record<string, string | null | undefined>;

const norm = (value: string) => value.trim().toLowerCase();

/** Only known fields with at least one value; values trimmed and de-duplicated. */
export function cleanConditions(role: string, raw: unknown): Conditions {
  const allowed = new Set(ASSIGNMENT_ROLES[role]?.fields.map((f) => f.key));
  const out: Conditions = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, values] of Object.entries(raw as Record<string, unknown>)) {
    if (!allowed.has(key) || !Array.isArray(values)) continue;
    const kept = [
      ...new Set(
        values
          .filter((v): v is string => typeof v === 'string')
          .map((v) => v.trim())
          .filter(Boolean),
      ),
    ];
    if (kept.length) out[key] = kept;
  }
  return out;
}

/**
 * A rule matches when every field it names holds one of its values
 * (case-insensitive). A field the work does not carry fails the rule — an
 * unknown industry is not "any industry". No conditions = catch-all.
 */
export function ruleMatches(conditions: Conditions, criteria: Criteria) {
  return Object.entries(conditions).every(([key, values]) => {
    const value = criteria[key];
    if (typeof value !== 'string' || !value.trim()) return false;
    return values.some((v) => norm(v) === norm(value));
  });
}

export interface Candidate {
  userId: string;
  /** งานเปิดของบทบาทนี้ที่ถืออยู่ */
  open: number;
  /** ได้งานของบทบาทนี้ครั้งล่าสุด — null = ยังไม่เคย */
  lastAssignedAt: Date | null;
}

/**
 * งานน้อยสุดก่อน; เท่ากันวนคิว = คนที่ได้งานล่าสุดนานที่สุด (ไม่เคยได้ก่อนใคร);
 * ยังเท่ากันอีก ตัดด้วย userId ให้ผลคงที่.
 */
export function pickCandidate(candidates: Candidate[]): Candidate | null {
  const time = (c: Candidate) => c.lastAssignedAt?.getTime() ?? -Infinity;
  return (
    [...candidates].sort(
      (a, b) =>
        a.open - b.open ||
        time(a) - time(b) ||
        a.userId.localeCompare(b.userId),
    )[0] ?? null
  );
}
