/**
 * CD-142 — the rules of a partner's technical profile, pure so they are
 * tested on their own. The commercial side (name, tax id, terms) is SAP's
 * and is never cleaned or stored here.
 */

export interface PartnerBrand {
  /** Brand or product line, e.g. "Fortinet". */
  brand: string;
  /** Partner level, e.g. "Gold Partner". */
  level: string;
  /** YYYY-MM-DD, "" when the level does not expire. */
  expiresOn: string;
}

export interface PartnerCertification {
  /** Certificate, e.g. "NSE 7". */
  name: string;
  /** How many engineers hold it (≥ 1). */
  holders: number;
  /** YYYY-MM-DD, "" when it does not expire. */
  expiresOn: string;
}

export interface PartnerContact {
  name: string;
  /** e.g. "วิศวกรขาย", "ซัพพอร์ต 24x7". */
  role: string;
  phone: string;
  email: string;
}

export const PARTNER_FILE_CATEGORIES = [
  'certificate',
  'datasheet',
  'catalog',
  'other',
] as const;
export type PartnerFileCategory = (typeof PARTNER_FILE_CATEGORIES)[number];

export const MAX_PARTNER_ROWS = 100;
export const MAX_PARTNER_TEXT = 300;
export const MAX_PARTNER_SUMMARY = 5000;
/** A level or certificate expiring within this many days is flagged. */
export const EXPIRY_WARNING_DAYS = 60;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isIsoDate = (value: string) =>
  ISO_DATE.test(value) &&
  !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime());

const text = (value: unknown) =>
  typeof value === 'string' ? value.trim().slice(0, MAX_PARTNER_TEXT) : '';
const date = (value: unknown) =>
  typeof value === 'string' && isIsoDate(value) ? value : '';
const rows = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.filter(
        (row): row is Record<string, unknown> =>
          !!row && typeof row === 'object',
      )
    : [];

/** A stored `brands` column, read defensively. */
export function readBrands(value: unknown): PartnerBrand[] {
  return rows(value)
    .map((row) => ({
      brand: text(row.brand),
      level: text(row.level),
      expiresOn: date(row.expiresOn),
    }))
    .filter((row) => row.brand);
}

export function readCertifications(value: unknown): PartnerCertification[] {
  return rows(value)
    .map((row) => ({
      name: text(row.name),
      holders:
        typeof row.holders === 'number' && Number.isInteger(row.holders)
          ? Math.max(1, row.holders)
          : 1,
      expiresOn: date(row.expiresOn),
    }))
    .filter((row) => row.name);
}

export function readContacts(value: unknown): PartnerContact[] {
  return rows(value)
    .map((row) => ({
      name: text(row.name),
      role: text(row.role),
      phone: text(row.phone),
      email: text(row.email),
    }))
    .filter((row) => row.name);
}

export interface PartnerProfileInput {
  summary?: unknown;
  brands?: unknown;
  certifications?: unknown;
  contacts?: unknown;
}

/**
 * What a save stores, or the problems with it. Blank rows are dropped (a
 * form leaves them); a row with a name but a bad date is a problem, not a
 * silent drop, since the date is the reason the row is there.
 */
export function cleanProfile(input: PartnerProfileInput):
  | {
      ok: true;
      summary: string;
      brands: PartnerBrand[];
      certifications: PartnerCertification[];
      contacts: PartnerContact[];
    }
  | { ok: false; problems: { field: string; reason: string }[] } {
  const problems: { field: string; reason: string }[] = [];
  const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
  if (summary.length > MAX_PARTNER_SUMMARY) {
    problems.push({ field: 'summary', reason: 'too_long' });
  }

  const checkDates = (field: string, list: Record<string, unknown>[]) =>
    list.forEach((row, index) => {
      const value = row.expiresOn ?? row.expires_on;
      if (typeof value === 'string' && value.trim() && !isIsoDate(value)) {
        problems.push({
          field: `${field}[${index}].expires_on`,
          reason: 'invalid_date',
        });
      }
    });
  const normal = (list: unknown) =>
    rows(list).map((row) => ({
      ...row,
      expiresOn: row.expiresOn ?? row.expires_on,
    }));

  const brandRows = normal(input.brands);
  const certRows = normal(input.certifications);
  const contactRows = rows(input.contacts);
  for (const [field, list] of [
    ['brands', brandRows],
    ['certifications', certRows],
    ['contacts', contactRows],
  ] as const) {
    if (list.length > MAX_PARTNER_ROWS) {
      problems.push({ field, reason: 'too_many' });
    }
  }
  checkDates('brands', brandRows);
  checkDates('certifications', certRows);

  const contacts = readContacts(contactRows);
  contacts.forEach((row, index) => {
    if (row.email && !/^[^\s@]+@[^\s@]+$/.test(row.email)) {
      problems.push({
        field: `contacts[${index}].email`,
        reason: 'invalid_email',
      });
    }
  });

  if (problems.length) return { ok: false, problems };
  return {
    ok: true,
    summary,
    brands: readBrands(brandRows),
    certifications: readCertifications(certRows),
    contacts,
  };
}

export type ExpiryState = 'expired' | 'expiring' | 'valid' | 'none';

/** Where a level or certificate stands on `today` (YYYY-MM-DD). */
export function expiryState(expiresOn: string, today: string): ExpiryState {
  if (!expiresOn) return 'none';
  if (expiresOn < today) return 'expired';
  const warnFrom = new Date(`${today}T00:00:00Z`);
  warnFrom.setUTCDate(warnFrom.getUTCDate() + EXPIRY_WARNING_DAYS);
  return expiresOn <= warnFrom.toISOString().slice(0, 10)
    ? 'expiring'
    : 'valid';
}

/** The partner list's warning column: expired and soon-to-expire entries. */
export function expiryCounts(
  profile: { brands: unknown; certifications: unknown },
  today: string,
) {
  const states = [
    ...readBrands(profile.brands).map((row) => row.expiresOn),
    ...readCertifications(profile.certifications).map((row) => row.expiresOn),
  ].map((value) => expiryState(value, today));
  return {
    expired: states.filter((state) => state === 'expired').length,
    expiring: states.filter((state) => state === 'expiring').length,
  };
}
