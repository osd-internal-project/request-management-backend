/**
 * ชนิดเอกสารที่มีเลขรัน — ค่าเดียวกับคอลัมน์ `run_number_settings."docType"`.
 * คอลัมน์เป็น text ไม่ใช่ enum: เพิ่มชนิดใหม่ต้องไม่ต้องมี migration (D-09).
 */
export const RUN_NUMBER_DOC_TYPES = [
  'REQUEST',
  'CUSTOMER',
  'OPPORTUNITY',
  'SALE_ORDER',
  'QUOTATION',
] as const;

export type RunNumberDocType = (typeof RUN_NUMBER_DOC_TYPES)[number];

export function isRunNumberDocType(value: string): value is RunNumberDocType {
  return (RUN_NUMBER_DOC_TYPES as readonly string[]).includes(value);
}

/** ตรงกับ enum `RunNumberResetPeriod` ใน schema.prisma. */
export const RUN_NUMBER_RESET_PERIODS = [
  'none',
  'yearly',
  'monthly',
  'daily',
] as const;

export type RunNumberReset = (typeof RUN_NUMBER_RESET_PERIODS)[number];

/** ส่วนของ setting ที่การ render ต้องใช้ — ไม่ผูกกับ row ของ Prisma. */
export interface RunNumberFormat {
  readonly pattern: string;
  readonly seqPadding: number;
  readonly startNumber: number;
  readonly resetPeriod: RunNumberReset;
}

/**
 * ข้อเท็จจริงที่ผู้เรียกส่งมาให้ออกเลขหนึ่งครั้ง.
 * ทุกค่ามาจากผู้เรียก — ตารางที่เป็นแหล่งของมันเป็นของ service อื่น (§03).
 */
export interface RunNumberContext {
  readonly companyId: string;
  readonly docType: RunNumberDocType;
  /** `typeCode` ของคำขอ หรือ `*` — เป็นทั้งตัวเลือก setting และคีย์ของ counter. */
  readonly scopeKey: string;
  readonly companyPrefix: string;
  readonly companyCode: string;
  readonly at: Date;
  /** `'M:REQUEST_TYPE' → 'PS01'` */
  readonly master?: Readonly<Record<string, string>>;
}
