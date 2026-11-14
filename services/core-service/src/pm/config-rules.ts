import type { SecretKeyring } from '@request-management/share';
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

const V2 = 'v2:';

/** A secret, encrypted (AES-256-GCM) under the active key; `v2:<kid>:` names that key. */
export function sealSecret(value: string, ring: SecretKeyring): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    'aes-256-gcm',
    keyOf(ring.keys[ring.active]),
    iv,
  );
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const sealed = [iv, cipher.getAuthTag(), body]
    .map((part) => part.toString('base64url'))
    .join('.');
  return `${V2}${ring.active}:${sealed}`;
}

function openWith(sealed: string, secret: string): string | null {
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

/** The secret back, or null when it cannot be read (key retired or changed, tampered). */
export function openSecret(
  sealed: string,
  ring: SecretKeyring | undefined,
): string | null {
  if (!ring) return null;
  if (sealed.startsWith(V2)) {
    const rest = sealed.slice(V2.length);
    const at = rest.indexOf(':');
    const key = at > 0 ? ring.keys[rest.slice(0, at)] : undefined;
    return key ? openWith(rest.slice(at + 1), key) : null;
  }
  // Sealed before key ids: the old single key, else whichever key still opens it.
  const candidates = [ring.legacy, ...Object.values(ring.keys)];
  for (const secret of candidates) {
    if (!secret) continue;
    const opened = openWith(sealed, secret);
    if (opened !== null) return opened;
  }
  return null;
}

/** True when a value is already sealed under the active key — what `secrets:reseal` skips. */
export function sealedUnderActive(
  sealed: string,
  ring: SecretKeyring,
): boolean {
  return sealed.startsWith(`${V2}${ring.active}:`);
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
