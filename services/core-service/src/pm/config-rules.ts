import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

/**
 * CD-217 ตั้งค่าระบบ — the rules, apart from the database: what a value
 * needs, how a secret is sealed, and what a search may match.
 */

export const MAX_CONFIG_KEY = 200;
export const MAX_CONFIG_VALUE = 4000;
export const MAX_CONFIG_REASON = 1000;
export const MASK = '••••••';

/** A value's own problems, in Thai. */
export function configProblems(input: {
  system: string;
  key: string;
  value: string;
  isSecret: boolean;
  /** an existing secret kept as it is (no new value given) */
  keepSecret: boolean;
  reason: string;
  /** an edit or a restore needs a reason; a first entry does not */
  needsReason: boolean;
}): string[] {
  const problems: string[] = [];
  if (!input.system.trim()) problems.push('ต้องระบุระบบหรืออุปกรณ์');
  if (input.system.length > MAX_CONFIG_KEY) {
    problems.push(`ชื่อระบบยาวเกิน ${MAX_CONFIG_KEY} ตัวอักษร`);
  }
  if (!input.key.trim()) problems.push('ต้องระบุชื่อค่า (key)');
  if (input.key.length > MAX_CONFIG_KEY) {
    problems.push(`ชื่อค่ายาวเกิน ${MAX_CONFIG_KEY} ตัวอักษร`);
  }
  if (!input.value && !(input.isSecret && input.keepSecret)) {
    problems.push('ต้องระบุค่า');
  }
  if (input.value.length > MAX_CONFIG_VALUE) {
    problems.push(`ค่ายาวเกิน ${MAX_CONFIG_VALUE} ตัวอักษร`);
  }
  if (input.needsReason && !input.reason.trim()) {
    problems.push('ต้องระบุเหตุผลที่เปลี่ยน');
  }
  return problems;
}

function keyOf(secret: string): Buffer {
  return createHash('sha256').update(`project-config:${secret}`).digest();
}

/** A secret, encrypted (AES-256-GCM); each sealing differs. */
export function sealSecret(value: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyOf(secret), iv);
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), body]
    .map((part) => part.toString('base64url'))
    .join('.');
}

/** The secret back, or null when it cannot be read (another key, tampered). */
export function openSecret(sealed: string, secret: string): string | null {
  try {
    const [iv, tag, body] = sealed
      .split('.')
      .map((part) => Buffer.from(part, 'base64url'));
    const decipher = createDecipheriv('aes-256-gcm', keyOf(secret), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString(
      'utf8',
    );
  } catch {
    return null;
  }
}

/** Does a value match a search? Secrets are never matched by value. */
export function matchesSearch(
  row: {
    system: string;
    key: string;
    value: string | null;
    note: string | null;
  },
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [row.system, row.key, row.value, row.note].some((text) =>
    (text ?? '').toLowerCase().includes(q),
  );
}
