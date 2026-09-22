import {
  RUN_NUMBER_DOC_TYPES,
  type RunNumberDocType,
  type RunNumberReset,
} from './run-number.types';

/** ส่วนของวันที่ที่ token หนึ่งตัวบอกได้ — ใช้ตรวจว่ารอบรีเซ็ตมี token รองรับครบ. */
export type DateGrain = 'year' | 'month' | 'day';

export interface RunNumberTokenDef {
  /** ชื่อใน pattern โดยไม่มีปีกกา เช่น `SEQ`, `M:REQUEST_TYPE`. */
  readonly token: string;
  /** ข้อความบนหน้าตั้งค่า. */
  readonly label: string;
  /** ค่าตัวอย่างสำหรับ preview และสำหรับวัดความยาวของเลขที่จะออก. */
  readonly sample: string;
  readonly grain?: DateGrain;
}

/**
 * token ที่ใช้ได้กับทุกชนิดเอกสาร.
 * คำนำหน้าอย่าง `REQ`/`CUS` เป็นตัวอักษรตรง ๆ ใน pattern ไม่ใช่ token.
 */
export const FIXED_TOKENS: readonly RunNumberTokenDef[] = [
  { token: 'COMPANY_PREFIX', label: 'คำนำหน้าเอกสารของบริษัท', sample: 'OSD' },
  { token: 'COMPANY_CODE', label: 'รหัสบริษัท', sample: 'OSD' },
  { token: 'YYYY', label: 'ปี ค.ศ. 4 หลัก', sample: '2026', grain: 'year' },
  { token: 'YY', label: 'ปี ค.ศ. 2 หลัก', sample: '26', grain: 'year' },
  { token: 'BYYYY', label: 'ปี พ.ศ. 4 หลัก', sample: '2569', grain: 'year' },
  { token: 'BYY', label: 'ปี พ.ศ. 2 หลัก', sample: '69', grain: 'year' },
  { token: 'MM', label: 'เดือน 2 หลัก', sample: '09', grain: 'month' },
  { token: 'DD', label: 'วันที่ 2 หลัก', sample: '22', grain: 'day' },
  { token: 'SEQ', label: 'ลำดับ', sample: '0001' },
  /*
    สามตัวนี้คือรูปแบบเดิมของ `doc_number_configs` ยังต้องทำงานต่อได้ — pattern
    ใน production ใช้อยู่ ลบทิ้งคือทำให้เลขที่คำขอเปลี่ยนรูปแบบเงียบ ๆ ตอน deploy.
  */
  { token: 'YYYYMM', label: 'ปีเดือน ค.ศ. (รูปแบบเดิม)', sample: '202609' },
  { token: 'YYMM', label: 'ปีเดือนย่อ (รูปแบบเดิม)', sample: '2609' },
  { token: 'YYYYMMDD', label: 'ปีเดือนวัน ค.ศ.', sample: '20260922' },
  {
    token: 'PREFIX',
    label: 'คำนำหน้าบริษัท (ชื่อเดิมของ COMPANY_PREFIX)',
    sample: 'OSD',
  },
];

/**
 * `{TYPE}` แจกให้เฉพาะชนิดเอกสารที่มีขอบเขตย่อยจริง.
 * ชนิดอื่น `scopeKey` เป็น `*` เสมอ ซึ่งจะหลุดไปอยู่ในรหัสเอกสาร.
 */
const SCOPE_TOKEN: RunNumberTokenDef = {
  token: 'TYPE',
  label: 'ขอบเขต (ประเภทคำขอ)',
  sample: 'PS01',
};

/** ชนิดเอกสารที่ `scopeKey` เป็นค่าจริง ไม่ใช่ `*`. */
export const SCOPED_DOC_TYPES: readonly RunNumberDocType[] = ['REQUEST'];

/** token รวมหลายส่วน — ตารางแยกเพราะ `grain` เดี่ยวบอกไม่ครบ. */
const COMPOSITE_GRAINS: Readonly<Record<string, readonly DateGrain[]>> = {
  YYYYMM: ['year', 'month'],
  YYMM: ['year', 'month'],
  YYYYMMDD: ['year', 'month', 'day'],
};

/**
 * token จาก master data ที่แต่ละชนิดเอกสารอ้างได้.
 * ประกาศได้เฉพาะ token ที่ผู้เรียกส่งค่าให้จริง — docs/run-number.md.
 */
export const MASTER_TOKENS: Readonly<
  Record<RunNumberDocType, readonly RunNumberTokenDef[]>
> = {
  REQUEST: [
    { token: 'M:REQUEST_TYPE', label: 'รหัสประเภทคำขอ', sample: 'PS01' },
  ],
  CUSTOMER: [],
  OPPORTUNITY: [],
  SALE_ORDER: [],
  QUOTATION: [],
};

/** token ทั้งหมดที่ชนิดเอกสารนี้อ้างได้ — หน้าตั้งค่าแสดงรายการนี้. */
export function tokensFor(
  docType: RunNumberDocType,
): readonly RunNumberTokenDef[] {
  return [
    ...FIXED_TOKENS,
    ...(SCOPED_DOC_TYPES.includes(docType) ? [SCOPE_TOKEN] : []),
    ...MASTER_TOKENS[docType],
  ];
}

/** ส่วนของวันที่ที่ token นี้บอกได้ — ว่างถ้าไม่เกี่ยวกับวันที่. */
export function grainsOf(token: string): readonly DateGrain[] {
  const composite = COMPOSITE_GRAINS[token];
  if (composite) return composite;

  const def = FIXED_TOKENS.find((candidate) => candidate.token === token);

  return def?.grain ? [def.grain] : [];
}

/** ส่วนของวันที่ที่รอบรีเซ็ตนี้ต้องมี token รองรับ ไม่งั้นเลขจะซ้ำข้ามรอบ. */
export function grainsRequiredBy(reset: RunNumberReset): readonly DateGrain[] {
  switch (reset) {
    case 'yearly':
      return ['year'];
    case 'monthly':
      return ['year', 'month'];
    case 'daily':
      return ['year', 'month', 'day'];
    case 'none':
      return [];
  }
}

export { RUN_NUMBER_DOC_TYPES };
