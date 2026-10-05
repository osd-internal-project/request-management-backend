/**
 * CD-251 ชุดเอกสารส่งมอบ — the rules, apart from the database. A phase (a
 * milestone delivered in one or more trips, CD-250) must leave the documents
 * its work types require: the work types are the BOQ kinds of the lines its
 * trips carry, and each company names the documents per work type (CRM
 * settings; a work type it has not named uses the standard below). A
 * document counts when a file is attached under its name; anything else
 * attached is extra.
 */

export const DELIVERY_WORK_TYPES = [
  'equipment',
  'material',
  'software',
  'service',
] as const;
export type DeliveryWorkType = (typeof DELIVERY_WORK_TYPES)[number];

export const DEFAULT_DELIVERY_DOCUMENTS: Record<DeliveryWorkType, string[]> = {
  equipment: ['ใบส่งของ', 'ใบรับประกันอุปกรณ์', 'คู่มือการใช้งานอุปกรณ์'],
  material: ['ใบส่งของ'],
  software: ['คู่มือผู้ใช้', 'บันทึกการเปลี่ยนแปลงเวอร์ชัน (Release note)'],
  service: ['รายงานการให้บริการ'],
};

export const MAX_DOCS_PER_TYPE = 20;
export const MAX_DOC_TITLE = 255;

const norm = (title: string) => title.trim().replace(/\s+/g, ' ').toLowerCase();

/** The company's setting, each work type falling back to the standard. */
export function documentsByType(
  setting: unknown,
): Record<DeliveryWorkType, string[]> {
  const saved =
    setting && typeof setting === 'object' && !Array.isArray(setting)
      ? (setting as Record<string, unknown>)
      : {};
  return Object.fromEntries(
    DELIVERY_WORK_TYPES.map((type) => {
      const list = saved[type];
      return [
        type,
        Array.isArray(list)
          ? list.filter((t): t is string => typeof t === 'string')
          : DEFAULT_DELIVERY_DOCUMENTS[type],
      ];
    }),
  ) as Record<DeliveryWorkType, string[]>;
}

/** The setting as an admin sends it: known types, names trimmed, each once. */
export function cleanDocumentsSetting(input: Record<string, unknown>): {
  value: Partial<Record<DeliveryWorkType, string[]>>;
  problems: string[];
} {
  const value: Partial<Record<DeliveryWorkType, string[]>> = {};
  const problems: string[] = [];
  for (const [key, raw] of Object.entries(input)) {
    if (!(DELIVERY_WORK_TYPES as readonly string[]).includes(key)) {
      problems.push(`ประเภทงาน ${key} ไม่รู้จัก`);
      continue;
    }
    if (!Array.isArray(raw) || raw.some((t) => typeof t !== 'string')) {
      problems.push(`${key}: ต้องเป็นรายชื่อเอกสาร`);
      continue;
    }
    const titles: string[] = [];
    for (const title of (raw as string[])
      .map((t) => t.trim())
      .filter(Boolean)) {
      if (title.length > MAX_DOC_TITLE)
        problems.push(`${key}: ชื่อเอกสารยาวเกิน ${MAX_DOC_TITLE} ตัวอักษร`);
      if (!titles.some((t) => norm(t) === norm(title))) titles.push(title);
    }
    if (titles.length > MAX_DOCS_PER_TYPE)
      problems.push(`${key}: ได้ไม่เกิน ${MAX_DOCS_PER_TYPE} เอกสาร`);
    value[key as DeliveryWorkType] = titles;
  }
  return { value, problems };
}

/** The documents a phase of these work types requires, each name once. */
export function requiredFor(
  byType: Record<DeliveryWorkType, string[]>,
  workTypes: readonly string[],
): string[] {
  const out: string[] = [];
  for (const type of DELIVERY_WORK_TYPES) {
    if (!workTypes.includes(type)) continue;
    for (const title of byType[type]) {
      if (!out.some((t) => norm(t) === norm(title))) out.push(title.trim());
    }
  }
  return out;
}

/** The pack: each required name with its files, extras, and what is missing. */
export function packStatus<T extends { title: string }>(
  required: readonly string[],
  documents: readonly T[],
) {
  const rows = required.map((title) => ({
    title,
    documents: documents.filter((d) => norm(d.title) === norm(title)),
  }));
  const extras = documents.filter(
    (d) => !required.some((title) => norm(title) === norm(d.title)),
  );
  const missing = rows.filter((r) => !r.documents.length).map((r) => r.title);
  return { required: rows, extras, missing, complete: missing.length === 0 };
}

/**
 * The phase the readiness check looks at: the first milestone (by order)
 * not yet achieved or cancelled that has a live delivery trip.
 */
export function nextPhase<
  M extends { id: string; seq: number; status: string },
>(milestones: readonly M[], tripMilestoneIds: readonly string[]): M | null {
  return (
    [...milestones]
      .filter(
        (m) =>
          m.status !== 'achieved' &&
          m.status !== 'cancelled' &&
          tripMilestoneIds.includes(m.id),
      )
      .sort((a, b) => a.seq - b.seq)[0] ?? null
  );
}
