import type { KycRiskLevel } from '@prisma/client';
import { nameSimilarity, normalizeCustomerName } from './customer-name';

/**
 * CD-61 — the rules a KYC verification rests on, kept pure so each is tested
 * on its own: screening against the company's prohibited list, the risk the
 * system suggests, what the reviewer's form says, and the dates that follow.
 */

/** Names at least this alike are reported as a possible match. */
export const WATCHLIST_NAME_THRESHOLD = 0.85;

/** Warn the owner this many days before a KYC runs out. */
export const KYC_WARN_DAYS = 30;

export interface WatchlistEntry {
  id: string;
  name: string;
  normalizedName: string;
  taxId: string | null;
  reason: string;
}

export interface ScreeningMatch {
  entryId: string;
  name: string;
  taxId: string | null;
  reason: string;
  /** 1 for an exact tax-id hit; the name similarity otherwise. */
  score: number;
  byTaxId: boolean;
}

const digits = (value: string | null | undefined) =>
  (value ?? '').replace(/\D/g, '');

/**
 * Every entry that may be this customer: the same tax id (exact — a tax id is
 * an identity), or a name alike enough after legal forms and spacing are
 * stripped. Strongest first.
 */
export function screenAgainst(
  customer: { nameTh: string; nameEn?: string | null; taxId: string | null },
  entries: readonly WatchlistEntry[],
): ScreeningMatch[] {
  const taxId = digits(customer.taxId);
  const names = [customer.nameTh, customer.nameEn]
    .filter((name): name is string => Boolean(name?.trim()))
    .map(normalizeCustomerName);

  const matches: ScreeningMatch[] = [];
  for (const entry of entries) {
    const byTaxId = Boolean(taxId) && digits(entry.taxId) === taxId;
    const score = byTaxId
      ? 1
      : Math.max(
          0,
          ...names.map((name) => nameSimilarity(name, entry.normalizedName)),
        );
    if (byTaxId || score >= WATCHLIST_NAME_THRESHOLD) {
      matches.push({
        entryId: entry.id,
        name: entry.name,
        taxId: entry.taxId,
        reason: entry.reason,
        score: Math.round(score * 100) / 100,
        byTaxId,
      });
    }
  }
  return matches.sort((a, b) => b.score - a.score);
}

/**
 * What the system suggests (user decision 28 ก.ย. 2569: the reviewer decides,
 * the system suggests): a list match is high; a required document missing is
 * medium; otherwise low.
 */
export function suggestRisk(input: {
  matches: readonly ScreeningMatch[];
  missingDocs: readonly string[];
}): KycRiskLevel {
  if (input.matches.length) return 'high';
  if (input.missingDocs.length) return 'medium';
  return 'low';
}

/** The reviewer's KYC form (the KYC type's receiver form), read defensively. */
export interface ReviewerAnswers {
  riskLevel: KycRiskLevel | null;
  documentsExpireOn: string | null;
  signatories: string | null;
  clearanceNote: string | null;
}

const RISK_LABELS: Record<string, KycRiskLevel> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  ต่ำ: 'low',
  กลาง: 'medium',
  สูง: 'high',
};

const isoDate = (value: unknown): string | null =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)
    ? value.slice(0, 10)
    : null;

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

export function readReviewerAnswers(data: unknown): ReviewerAnswers {
  const form =
    data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  const risk = text(form.risk_level);
  return {
    riskLevel: risk ? (RISK_LABELS[risk] ?? null) : null,
    documentsExpireOn: isoDate(form.documents_expire_on),
    signatories: text(form.signatories),
    clearanceNote: text(form.screening_clearance),
  };
}

/** `YYYY-MM-DD` plus whole months, clamped to the month's last day. */
export function addMonths(isoDay: string, months: number): string {
  const [year, month, day] = isoDay.split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const last = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, last));
  return target.toISOString().slice(0, 10);
}

export interface ReviewMonths {
  high: number;
  medium: number;
  low: number;
}

/** When the verification must be reviewed, and when it runs out. */
export function kycDates(
  verifiedOn: string,
  risk: KycRiskLevel,
  months: ReviewMonths,
  documentsExpireOn: string | null,
): { reviewDueOn: string; expiresOn: string } {
  const reviewDueOn = addMonths(verifiedOn, months[risk]);
  const expiresOn =
    documentsExpireOn && documentsExpireOn < reviewDueOn
      ? documentsExpireOn
      : reviewDueOn;
  return { reviewDueOn, expiresOn };
}

/** Today in Bangkok as `YYYY-MM-DD`. */
export function bangkokDay(at: Date): string {
  return new Date(at.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
}
