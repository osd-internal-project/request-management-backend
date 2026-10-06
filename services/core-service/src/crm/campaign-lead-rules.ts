import { randomBytes } from 'node:crypto';

/**
 * CD-269 — the rules a Lead from a campaign goes through before it reaches
 * anyone: the same person registering twice, and an ad platform's payload
 * read into the Lead's fields. Pure, so the form, the API and the ad webhook
 * agree.
 */

/** A registration this recent from the same person joins the open Lead. */
export const REPEAT_WINDOW_DAYS = 30;

/** Lowercased e-mail; null when there is none worth matching. */
export function emailKey(value: string | null | undefined): string | null {
  const email = (value ?? '').trim().toLowerCase();
  return email.includes('@') ? email : null;
}

/**
 * The last nine digits of a Thai number — `081-234-5678`, `+66 81 234 5678`
 * and `0812345678` are the same phone. Fewer than nine digits is not a
 * number to match on.
 */
export function phoneKey(value: string | null | undefined): string | null {
  const digits = (value ?? '').replace(/\D/g, '');
  return digits.length >= 9 ? digits.slice(-9) : null;
}

/** Does this stored phone/e-mail belong to the same person. */
export function samePerson(
  wanted: { email: string | null; phone: string | null },
  found: { email: string | null; phone: string | null },
): boolean {
  return (
    (wanted.email !== null && emailKey(found.email) === wanted.email) ||
    (wanted.phone !== null && phoneKey(found.phone) === wanted.phone)
  );
}

export const AD_PLATFORMS = ['facebook', 'tiktok'] as const;
export type AdPlatform = (typeof AD_PLATFORMS)[number];

export interface AdLead {
  formId: string;
  name: string;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  note: string | null;
}

type Fields = Record<string, string>;

/**
 * The Lead Ads payload as a field map. Facebook's lead retrieval gives
 * `field_data: [{ name, values: [] }]`; TikTok's gives `answers` /
 * `user_info` as `{ field_name, value }`. Unknown shapes give an empty map.
 */
export function adFields(platform: AdPlatform, payload: unknown): Fields {
  const body = (payload ?? {}) as Record<string, unknown>;
  const out: Fields = {};
  const put = (key: unknown, value: unknown) => {
    if (typeof key !== 'string') return;
    const text = Array.isArray(value) ? value[0] : value;
    if (typeof text === 'string' && text.trim()) {
      out[key.trim().toLowerCase()] = text.trim();
    }
  };
  if (platform === 'facebook') {
    for (const row of (body.field_data as unknown[]) ?? []) {
      const field = row as { name?: unknown; values?: unknown };
      put(field.name, field.values);
    }
  } else {
    for (const list of [body.user_info, body.answers]) {
      for (const row of (list as unknown[]) ?? []) {
        const field = row as { field_name?: unknown; value?: unknown };
        put(field.field_name, field.value);
      }
    }
  }
  return out;
}

const pick = (fields: Fields, keys: string[]) =>
  keys.map((key) => fields[key]).find(Boolean) ?? null;

/** The Lead an ad answer makes, or null when it has no name or contact. */
export function adLead(platform: AdPlatform, payload: unknown): AdLead | null {
  const body = (payload ?? {}) as Record<string, unknown>;
  const formId = String(body.form_id ?? '').trim();
  const fields = adFields(platform, payload);
  const person =
    pick(fields, ['full_name', 'name']) ??
    ([fields.first_name, fields.last_name].filter(Boolean).join(' ') || null);
  const company = pick(fields, ['company_name', 'company', 'organization']);
  const phone = pick(fields, ['phone_number', 'phone', 'mobile']);
  const email = pick(fields, ['email', 'work_email']);
  const name = company ?? person;
  if (!formId || !name || (!phone && !email)) return null;
  const known = new Set([
    'full_name',
    'name',
    'first_name',
    'last_name',
    'company_name',
    'company',
    'organization',
    'phone_number',
    'phone',
    'mobile',
    'email',
    'work_email',
  ]);
  const rest = Object.entries(fields)
    .filter(([key]) => !known.has(key))
    .map(([key, value]) => `${key}: ${value}`);
  return {
    formId,
    name,
    contactName: company ? person : null,
    phone,
    email,
    note: rest.length ? rest.join('\n') : null,
  };
}

/** A fresh, unguessable token for a campaign's public form link. */
export function newFormToken(): string {
  return randomBytes(18).toString('base64url');
}
