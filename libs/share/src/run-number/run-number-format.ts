import {
  grainsOf,
  grainsRequiredBy,
  tokensFor,
  type RunNumberTokenDef,
} from './run-number-tokens';
import type {
  RunNumberContext,
  RunNumberDocType,
  RunNumberFormat,
  RunNumberReset,
} from './run-number.types';

/**
 * เขตเวลาที่ใช้ตัดวัน/เดือน/ปีของเลขรัน — เวลาไทย.
 * ตั้งเป็น 0 เพื่อกลับไปตัดตาม UTC แบบเดิม (docs/run-number.md).
 */
export const RUN_NUMBER_TZ_OFFSET_MINUTES = 420;

/** ปีพุทธศักราชต่างจากคริสต์ศักราชเท่านี้. */
const BUDDHIST_YEAR_OFFSET = 543;

/** ความยาวสูงสุดของเลขที่ออก — เท่ากับที่คอลัมน์ `requests."requestNo"` รับได้. */
export const MAX_RUN_NUMBER_LENGTH = 60;

/** จับ token ทุกตัวในครั้งเดียว — ลำดับการประกาศ token จึงไม่มีผล. */
const TOKEN_PATTERN = /\{([A-Z0-9_:]+)\}/g;

interface DateParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/** วัน/เดือน/ปีตามเวลาไทย. */
function partsOf(at: Date): DateParts {
  const shifted = new Date(
    at.getTime() + RUN_NUMBER_TZ_OFFSET_MINUTES * 60_000,
  );

  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * คีย์ของ counter สำหรับรอบรีเซ็ตนี้ — `-` เมื่อไม่รีเซ็ต.
 * ต้องเปลี่ยนเมื่อขึ้นรอบใหม่ และไม่ซ้ำกับรอบเก่า.
 */
export function periodKeyOf(reset: RunNumberReset, at: Date): string {
  const { year, month, day } = partsOf(at);

  switch (reset) {
    case 'none':
      return '-';
    case 'yearly':
      return String(year);
    case 'monthly':
      return `${year}${pad2(month)}`;
    case 'daily':
      return `${year}${pad2(month)}${pad2(day)}`;
  }
}

/** ค่าของทุก token ที่ context นี้ให้ได้. */
function valuesOf(
  ctx: RunNumberContext,
  seq: number,
  seqPadding: number,
): Readonly<Record<string, string>> {
  const { year, month, day } = partsOf(ctx.at);
  const buddhistYear = year + BUDDHIST_YEAR_OFFSET;

  return {
    COMPANY_PREFIX: ctx.companyPrefix,
    PREFIX: ctx.companyPrefix,
    COMPANY_CODE: ctx.companyCode,
    TYPE: ctx.scopeKey,
    YYYY: String(year),
    YY: String(year).slice(-2),
    BYYYY: String(buddhistYear),
    BYY: String(buddhistYear).slice(-2),
    MM: pad2(month),
    DD: pad2(day),
    YYYYMM: `${year}${pad2(month)}`,
    YYMM: `${String(year).slice(-2)}${pad2(month)}`,
    YYYYMMDD: `${year}${pad2(month)}${pad2(day)}`,
    SEQ: String(seq).padStart(seqPadding, '0'),
    ...(ctx.master ?? {}),
  };
}

/**
 * เลขที่ออกจริงสำหรับลำดับ `seq`.
 * token ที่ไม่มีค่าถูกทิ้งปีกกาไว้ ผู้เรียกกันด้วย `unresolvedTokens` ก่อน.
 */
export function formatRunNumber(
  setting: RunNumberFormat,
  ctx: RunNumberContext,
  seq: number,
): string {
  const values = valuesOf(ctx, seq, setting.seqPadding);

  return setting.pattern.replace(TOKEN_PATTERN, (match, token: string) =>
    token in values ? values[token] : match,
  );
}

/**
 * token ใน pattern ที่ context นี้ให้ค่าไม่ได้ — ว่างคือออกเลขได้.
 * `validatePattern` ถามว่ารูปแบบถูกไหม อันนี้ถามว่าข้อมูลมาครบไหม.
 */
export function unresolvedTokens(
  pattern: string,
  ctx: RunNumberContext,
): readonly string[] {
  const values = valuesOf(ctx, 1, 1);

  return [...new Set(tokensIn(pattern))].filter(
    (token) => !(token in values) || values[token] === '',
  );
}

/** token ทุกตัวที่ pattern นี้อ้าง เรียงตามที่พบ ซ้ำได้. */
export function tokensIn(pattern: string): readonly string[] {
  return [...pattern.matchAll(TOKEN_PATTERN)].map((match) => match[1]);
}

export interface PatternCheck {
  readonly pattern: string;
  readonly docType: RunNumberDocType;
  readonly resetPeriod: RunNumberReset;
  readonly seqPadding: number;
}

/**
 * เหตุผลที่ pattern นี้ใช้ไม่ได้ — ว่างคือผ่าน.
 * เรียกตอนบันทึกเสมอ ไม่ใช่ตอนออกเลข.
 */
export function validatePattern(input: PatternCheck): readonly string[] {
  const reasons: string[] = [];
  const allowed = tokensFor(input.docType);
  const used = tokensIn(input.pattern);

  const seqCount = used.filter((token) => token === 'SEQ').length;
  if (seqCount === 0) reasons.push('รูปแบบต้องมี {SEQ} เพื่อให้เลขไม่ซ้ำกัน');
  if (seqCount > 1) reasons.push('มี {SEQ} ได้ครั้งเดียวในหนึ่งรูปแบบ');

  const unknown = used.filter(
    (token) => !allowed.some((def) => def.token === token),
  );
  for (const token of new Set(unknown)) {
    reasons.push(`ไม่รู้จักตัวแปร {${token}} สำหรับเอกสารชนิดนี้`);
  }

  const provided = new Set(used.flatMap((token) => grainsOf(token)));
  const missing = grainsRequiredBy(input.resetPeriod).filter(
    (grain) => !provided.has(grain),
  );
  if (missing.length > 0) {
    reasons.push(
      'รอบรีเซ็ตที่เลือกต้องมีตัวแปรวันที่ในรูปแบบด้วย ' +
        `(ยังขาด: ${missing.map(grainLabel).join(', ')}) ` +
        'ไม่งั้นลำดับจะกลับมาทับเลขของรอบก่อน',
    );
  }

  if (input.seqPadding < 1 || input.seqPadding > 12) {
    reasons.push('ความยาวของลำดับต้องอยู่ระหว่าง 1 ถึง 12 หลัก');
  }

  const length = sampleLength(input, allowed);
  if (length > MAX_RUN_NUMBER_LENGTH) {
    reasons.push(
      `เลขที่ออกจะยาว ${length} ตัวอักษร เกินที่เก็บได้ ${MAX_RUN_NUMBER_LENGTH} ตัวอักษร`,
    );
  }

  return reasons;
}

/** ความยาวของเลขที่จะออก วัดจากค่าตัวอย่างของแต่ละ token. */
function sampleLength(
  input: PatternCheck,
  allowed: readonly RunNumberTokenDef[],
): number {
  return input.pattern.replace(TOKEN_PATTERN, (_match, token: string) => {
    if (token === 'SEQ') return '0'.repeat(input.seqPadding);
    return allowed.find((def) => def.token === token)?.sample ?? '';
  }).length;
}

function grainLabel(grain: 'year' | 'month' | 'day'): string {
  switch (grain) {
    case 'year':
      return 'ปี';
    case 'month':
      return 'เดือน';
    case 'day':
      return 'วัน';
  }
}
