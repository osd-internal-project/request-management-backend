/**
 * CD-291 — one comparable form of a phone or an email, so "+66 81-234-5678"
 * and "0812345678" are the same person on the do-not-contact register.
 */

/** Digits only, +66 → 0; too short to dial is no phone at all. */
export function normalizePhone(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  let digits = String(value)
    .trim()
    .replace(/[^\d+]/g, '');
  if (digits.startsWith('+66')) digits = `0${digits.slice(3)}`;
  digits = digits.replace(/\D/g, '');
  return digits.length >= 9 && digits.length <= 10 ? digits : null;
}

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : null;
}

export const CONTACT_KINDS = ['phone', 'email'] as const;
export type ContactKind = (typeof CONTACT_KINDS)[number];

/** `call` blocks phone calls only; `all` blocks every channel. */
export const OPT_OUT_CHANNELS = ['call', 'all'] as const;
export type OptOutChannel = (typeof OPT_OUT_CHANNELS)[number];

export const OPT_OUT_SOURCES = [
  'call_refusal',
  'manual',
  'import',
  'pdpa',
] as const;
export type OptOutSource = (typeof OPT_OUT_SOURCES)[number];

export function normalizeContact(kind: ContactKind, value: unknown) {
  return kind === 'phone' ? normalizePhone(value) : normalizeEmail(value);
}

/** Whether an entry stops contact on `channel` ('call' = a phone call, 'message' = anything else). */
export function blocks(entryChannel: string, channel: 'call' | 'message') {
  return (
    entryChannel === 'all' || (entryChannel === 'call' && channel === 'call')
  );
}
