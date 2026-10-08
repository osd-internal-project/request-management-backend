/**
 * CD-289 (CD-16 AI SMART) — what a swept row must be, and how it is tidied,
 * decided without a database.
 */

import { normalizePhone } from '../contact-preferences/contact-rules';

// CD-291 — one phone form for the staging list and the do-not-contact register
export { normalizePhone };

/** Sources a connector searches on a schedule. */
export const CONNECTOR_KINDS = ['dbd', 'web', 'social'] as const;
/** Sources fed from outside the scheduler: a vendor's push, a downloaded file. */
export const FED_KINDS = ['push', 'file'] as const;
export const SOURCE_KINDS = [...CONNECTOR_KINDS, ...FED_KINDS] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const SALES_AXES = [
  'getter',
  'government',
  'partner',
  'keeper',
] as const;
export type SalesAxis = (typeof SALES_AXES)[number];

export const PROSPECT_STATUSES = [
  'new',
  'screened',
  'sent',
  'discarded',
] as const;

/** One import or push carries at most this many rows. */
export const MAX_ROWS_PER_BATCH = 1000;

export const isConnectorKind = (kind: string) =>
  (CONNECTOR_KINDS as readonly string[]).includes(kind);

/** A row as a connector, a vendor or a file hands it over. */
export interface FoundProspect {
  externalRef?: string | null;
  name?: string | null;
  taxId?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  industry?: string | null;
  province?: string | null;
  registeredCapital?: number | string | null;
  salesAxis?: string | null;
  /** Where it was seen: url, snippet, and anything else the source returned. */
  evidence?: Record<string, unknown> | null;
}

/** The row as it is stored. */
export interface CleanProspect {
  externalRef: string;
  name: string;
  taxId: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  industry: string | null;
  province: string | null;
  registeredCapital: number | null;
  salesAxis: SalesAxis;
  evidence: Record<string, unknown>;
}

const text = (value: unknown, max = 300): string | null => {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const trimmed = String(value).trim().replace(/\s+/g, ' ');
  return trimmed ? trimmed.slice(0, max) : null;
};

/** A Thai juristic/tax id: 13 digits, separators dropped; anything else is not one. */
export function normalizeTaxId(value: unknown): string | null {
  const digits = (text(value) ?? '').replace(/[\s-]/g, '');
  return /^\d{13}$/.test(digits) ? digits : null;
}

const GOVERNMENT_NAME =
  /^(กรม|กระทรวง|สำนักงาน|สำนัก|องค์การบริหาร|องค์การ|เทศบาล|มหาวิทยาลัย|โรงพยาบาล|การไฟฟ้า|การประปา|การท่าเรือ|สถาบัน)/;

/**
 * The sales axis a row feeds: the row's own (when valid), else the source's,
 * else government for a public body's name, else getter (a new customer).
 */
export function axisFor(
  name: string,
  rowAxis: unknown,
  sourceAxis: string | null,
): SalesAxis {
  const valid = (value: unknown): value is SalesAxis =>
    (SALES_AXES as readonly string[]).includes(String(value));
  if (valid(rowAxis)) return rowAxis;
  if (valid(sourceAxis)) return sourceAxis;
  return GOVERNMENT_NAME.test(name) ? 'government' : 'getter';
}

/**
 * A row tidied for storage, or why it cannot be kept. A row needs a name and
 * some way to tell it apart — the source's ref, a tax id, a phone or a website.
 */
export function cleanProspect(
  row: FoundProspect,
  sourceAxis: string | null,
): { ok: true; row: CleanProspect } | { ok: false; reason: string } {
  const name = text(row.name, 200);
  if (!name) return { ok: false, reason: 'ไม่มีชื่อธุรกิจ' };
  const taxId = normalizeTaxId(row.taxId);
  const phone = normalizePhone(row.phone);
  const email = text(row.email, 200)?.toLowerCase() ?? null;
  const website = text(row.website, 300);
  const externalRef = text(row.externalRef, 200) ?? taxId ?? website ?? phone;
  if (!externalRef) {
    return {
      ok: false,
      reason: 'ไม่มีรหัสอ้างอิง เลขนิติบุคคล เบอร์โทร หรือเว็บไซต์',
    };
  }
  const capital = Number(row.registeredCapital);
  return {
    ok: true,
    row: {
      externalRef,
      name,
      taxId,
      phone,
      email: email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : null,
      website,
      industry: text(row.industry, 200),
      province: text(row.province, 100),
      registeredCapital:
        row.registeredCapital !== null &&
        row.registeredCapital !== undefined &&
        Number.isFinite(capital) &&
        capital >= 0
          ? capital
          : null,
      salesAxis: axisFor(name, row.salesAxis, sourceAxis),
      evidence:
        row.evidence && typeof row.evidence === 'object' ? row.evidence : {},
    },
  };
}

/** Whether a scheduled source is due: active, timed, and its interval has passed. */
export function isDue(
  source: {
    kind: string;
    active: boolean;
    intervalHours: number | null;
    lastRunAt: Date | null;
  },
  now: Date,
): boolean {
  if (!source.active || !isConnectorKind(source.kind)) return false;
  if (!source.intervalHours || source.intervalHours <= 0) return false;
  if (!source.lastRunAt) return true;
  return (
    now.getTime() - source.lastRunAt.getTime() >=
    source.intervalHours * 3_600_000
  );
}
