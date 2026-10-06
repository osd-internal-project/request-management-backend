/**
 * CD-280 (CD-23 AI CARE) — the rules of a conversation with a customer:
 * which channels there are, when a sender's next message starts a new
 * conversation, and how a sender is recognised as a customer's contact.
 */

export const CARE_CHANNELS = [
  'line',
  'facebook',
  'instagram',
  'tiktok',
  'email',
  'web',
  'callcenter',
  'api',
] as const;
export type CareChannel = (typeof CARE_CHANNELS)[number];

export const CARE_STATUSES = [
  'open',
  'waiting_human',
  'with_agent',
  'closed',
] as const;
export type CareStatus = (typeof CARE_STATUSES)[number];

export type Identification = 'unknown' | 'claimed' | 'verified';

export const DEFAULT_IDLE_HOURS = 24;
export const DEFAULT_RETENTION_DAYS = 180;
/** A message's text, at most. */
export const MAX_TEXT = 4000;

/**
 * The contact field a channel's own identity is — given by the platform, not
 * typed by the sender, so a match verifies. Other channels (Facebook, web
 * chat…) carry ids no contact holds: a staff member links them once.
 */
export function platformField(
  channel: CareChannel,
): 'lineId' | 'email' | 'phone' | null {
  switch (channel) {
    case 'line':
      return 'lineId';
    case 'email':
      return 'email';
    case 'callcenter':
      return 'phone';
    default:
      return null;
  }
}

/** Thai numbers compared on their last 9 digits (0xx… and +66xx… alike). */
export function phoneKey(value: string | null | undefined): string | null {
  const digits = (value ?? '').replace(/\D/g, '');
  return digits.length >= 9 ? digits.slice(-9) : null;
}

export function emailKey(value: string | null | undefined): string | null {
  const email = (value ?? '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

export interface Claims {
  phones: string[];
  emails: string[];
  customerCodes: string[];
}

/** Phone numbers, emails and customer codes a sender typed. */
export function claimsIn(text: string | null | undefined): Claims {
  const body = text ?? '';
  const phones = [...body.matchAll(/(?:\+?66[\s-]?|0)(?:\d[\s-]?){8,9}/g)]
    .map((m) => phoneKey(m[0]))
    .filter((p): p is string => !!p);
  const emails = [...body.matchAll(/[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}/gi)]
    .map((m) => emailKey(m[0]))
    .filter((e): e is string => !!e);
  const customerCodes = [...body.matchAll(/\bCUS-[A-Z0-9-]+\b/gi)].map((m) =>
    m[0].toUpperCase(),
  );
  return {
    phones: [...new Set(phones)],
    emails: [...new Set(emails)],
    customerCodes: [...new Set(customerCodes)],
  };
}

export function mergeClaims(...all: Partial<Claims>[]): Claims {
  const pick = (key: keyof Claims) => [
    ...new Set(all.flatMap((c) => c[key] ?? [])),
  ];
  return {
    phones: pick('phones'),
    emails: pick('emails'),
    customerCodes: pick('customerCodes'),
  };
}

/** A match counts only when it points at exactly one customer. */
export function onlyCustomer<T extends { customerId: string }>(
  rows: T[],
): T | null {
  const ids = new Set(rows.map((r) => r.customerId));
  return ids.size === 1 ? rows[0] : null;
}

/**
 * Whether a sender's message joins the conversation or starts a new one: a
 * conversation AI is handling ends after `idleHours` of silence; one waiting
 * for or with a person stays until someone closes it.
 */
export function continues(
  conversation: { status: string; lastMessageAt: Date },
  at: Date,
  idleHours: number,
): boolean {
  if (conversation.status === 'closed') return false;
  if (conversation.status !== 'open') return true;
  return (
    at.getTime() - conversation.lastMessageAt.getTime() < idleHours * 3600_000
  );
}

/** Identification never goes down within a conversation. */
export function stronger(
  current: Identification,
  next: Identification,
): boolean {
  const rank = { unknown: 0, claimed: 1, verified: 2 } as const;
  return rank[next] > rank[current];
}
