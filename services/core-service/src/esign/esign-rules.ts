/**
 * CD-14 ระบบลงนามอิเล็กทรอนิกส์ — the rules, apart from the database and
 * the PDF: layouts and where a field lands, links and one-time codes, and
 * who may sign when.
 */
import { createHash, createHmac, randomBytes, randomInt } from 'node:crypto';

export const POSITIONS = [
  'bottom-left',
  'bottom-center',
  'bottom-right',
  'top-left',
  'top-right',
] as const;
export type Position = (typeof POSITIONS)[number];
export type FieldPage = 'first' | 'last' | 'appendix' | number;

export interface LayoutField {
  key: string;
  /** Who signs here, as the document calls them: ผู้ว่าจ้าง, ผู้รับจ้าง, พยาน. */
  label: string;
  page: FieldPage;
  position: Position;
  /** Signing order (sequential envelopes); ties sign together. */
  order: number;
}

export const MAX_FIELDS = 12;

/** What stops a layout from being saved, in Thai. */
export function layoutProblems(fields: readonly LayoutField[]): string[] {
  const problems: string[] = [];
  if (!fields.length) problems.push('ต้องมีช่องลงนามอย่างน้อยหนึ่งช่อง');
  if (fields.length > MAX_FIELDS) {
    problems.push(`ช่องลงนามมีได้ไม่เกิน ${MAX_FIELDS} ช่อง`);
  }
  const keys = new Set<string>();
  const spots = new Set<string>();
  fields.forEach((field, index) => {
    const n = `ช่องที่ ${index + 1}`;
    if (!field.label.trim()) problems.push(`${n}: ต้องระบุผู้ลงนาม`);
    if (keys.has(field.key)) problems.push(`${n}: รหัสช่องซ้ำ`);
    keys.add(field.key);
    const pageOk =
      field.page === 'first' ||
      field.page === 'last' ||
      field.page === 'appendix' ||
      (typeof field.page === 'number' &&
        Number.isInteger(field.page) &&
        field.page >= 1);
    if (!pageOk) problems.push(`${n}: หน้าไม่ถูกต้อง`);
    if (!POSITIONS.includes(field.position)) {
      problems.push(`${n}: ตำแหน่งไม่ถูกต้อง`);
    }
    if (!Number.isInteger(field.order) || field.order < 1) {
      problems.push(`${n}: ลำดับต้องเป็นจำนวนเต็มตั้งแต่ 1`);
    }
    // two fields in one spot would print over each other
    if (field.page !== 'appendix') {
      const spot = `${String(field.page)}:${field.position}`;
      if (spots.has(spot)) {
        problems.push(`${n}: ซ้อนกับช่องอื่นในตำแหน่งเดียวกัน`);
      }
      spots.add(spot);
    }
  });
  return problems;
}

/** A box's size and margin, in PDF points. */
export const BOX = { width: 180, height: 70, margin: 36 };

/**
 * Where a field is drawn: which page (0-based) and the box's lower-left
 * corner. `appendix` fields go on the signature page, one row each; a page
 * number past the end falls on the last page.
 */
export function placement(
  field: Pick<LayoutField, 'page' | 'position'>,
  pageCount: number,
  size: { width: number; height: number },
  appendixSlot: number,
): { appendix: boolean; pageIndex: number; x: number; y: number } {
  if (field.page === 'appendix') {
    return {
      appendix: true,
      pageIndex: -1,
      x: BOX.margin + (appendixSlot % 2) * (BOX.width + 60),
      y: size.height - 170 - Math.floor(appendixSlot / 2) * (BOX.height + 60),
    };
  }
  const pageIndex =
    field.page === 'first'
      ? 0
      : field.page === 'last'
        ? pageCount - 1
        : Math.min(field.page - 1, pageCount - 1);
  const left = BOX.margin;
  const right = size.width - BOX.margin - BOX.width;
  const center = (size.width - BOX.width) / 2;
  const bottom = BOX.margin;
  const top = size.height - BOX.margin - BOX.height;
  const [row, column] = field.position.split('-') as [
    'top' | 'bottom',
    'left' | 'center' | 'right',
  ];
  return {
    appendix: false,
    pageIndex,
    x: column === 'left' ? left : column === 'right' ? right : center,
    y: row === 'top' ? top : bottom,
  };
}

// --- links and codes -------------------------------------------------------

/** A signing link's secret: shown once, only its hash is kept. */
export function newToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** A six-digit one-time code and its keyed hash. */
export function newOtp(secret: string): { code: string; hash: string } {
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  return { code, hash: hashOtp(code, secret) };
}

export function hashOtp(code: string, secret: string): string {
  return createHmac('sha256', secret).update(code).digest('hex');
}

export const OTP_TTL_MS = 10 * 60_000;
export const OTP_RESEND_MS = 60_000;
export const OTP_MAX_ATTEMPTS = 5;
/** How long a confirmed code keeps the link open. */
export const OTP_SESSION_MS = 30 * 60_000;

/** The verification page's reference: short enough to type from paper. */
export function newVerifyCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 12; i++) code += alphabet[randomInt(0, alphabet.length)];
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`;
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// --- who signs when ----------------------------------------------------------

export interface SignerState {
  id: string;
  order: number;
  status: string;
}

/**
 * May this signer sign now? In a sequential envelope everyone of a lower
 * order must have signed first; in a parallel one, anyone at any time.
 */
export function turnOf(
  signer: SignerState,
  all: readonly SignerState[],
  mode: string,
): { may: boolean; waitingFor: number } {
  if (mode !== 'sequential') return { may: true, waitingFor: 0 };
  const before = all.filter(
    (other) => other.order < signer.order && other.status !== 'signed',
  );
  return { may: before.length === 0, waitingFor: before.length };
}

/** Every signer signed. */
export function allSigned(all: readonly Pick<SignerState, 'status'>[]) {
  return all.length > 0 && all.every((signer) => signer.status === 'signed');
}

/** A signature image as sent by the page: PNG or JPEG data URL, ≤ 500 KB. */
export function readSignatureImage(
  dataUrl: string | undefined,
): { mime: 'image/png' | 'image/jpeg'; bytes: Buffer } | null {
  const match = /^data:(image\/png|image\/jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(
    dataUrl ?? '',
  );
  if (!match) return null;
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > 500_000) return null;
  return { mime: match[1] as 'image/png' | 'image/jpeg', bytes };
}
