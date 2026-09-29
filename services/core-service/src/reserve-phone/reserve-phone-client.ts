/**
 * CD-78 — the ONE doorway to Reserve-phone, the system that owns the phone
 * number inventory (spec §03: business modules never call an outside system
 * directly). Connect the Dot keeps no copy of the inventory: it asks what is
 * free, reserves against a deal, and records only which reservation belongs
 * to which deal.
 *
 *   RESERVE_PHONE_MODE=mock (default) — an in-memory stand-in, so every
 *   environment runs end-to-end. There is no other driver yet: Reserve-phone's
 *   API has not been handed over, and a guessed contract would fail quietly
 *   in production. Any other mode refuses to boot (docs/reserve-phone.md
 *   lists what the real driver must provide).
 */

export const RESERVE_PHONE_CLIENT = 'RESERVE_PHONE_CLIENT';

/** Which company a call is for — Reserve-phone may keep pools per company. */
export interface ReservePhoneContext {
  /** `companies.code`, e.g. `OSD`. */
  readonly companyCode: string;
}

export interface PhoneNumberSearch {
  /** Digits the number must contain, e.g. `888`. */
  readonly contains?: string;
  /** Digits the number must start with, e.g. `02`. */
  readonly prefix?: string;
  readonly category?: string;
  readonly limit: number;
}

export interface AvailablePhoneNumber {
  /** Digits only, e.g. `021234567`. */
  readonly number: string;
  /** e.g. `normal`, `golden` — Reserve-phone's own classes. */
  readonly category: string;
  /** One-off fee for the class, if Reserve-phone charges one. */
  readonly fee: number | null;
}

export interface PhoneReservation {
  /** Reserve-phone's id — what extend and release take. */
  readonly reservationId: string;
  readonly number: string;
  readonly category: string;
  readonly fee: number | null;
  readonly expiresAt: string;
}

/** The number was taken between search and reserve (or never existed). */
export class PhoneNumberUnavailableError extends Error {
  constructor(readonly number: string) {
    super(`เบอร์ ${number} ไม่ว่างแล้ว`);
  }
}

export interface ReservePhoneClient {
  readonly mode: 'mock';
  search(
    ctx: ReservePhoneContext,
    query: PhoneNumberSearch,
  ): Promise<AvailablePhoneNumber[]>;
  /** Throws PhoneNumberUnavailableError when the number is not free. */
  reserve(
    ctx: ReservePhoneContext,
    number: string,
    hold: { reference: string; expiresAt: string },
  ): Promise<PhoneReservation>;
  extend(
    ctx: ReservePhoneContext,
    reservationId: string,
    expiresAt: string,
  ): Promise<{ expiresAt: string }>;
  /** Idempotent — releasing an unknown or released reservation succeeds. */
  release(ctx: ReservePhoneContext, reservationId: string): Promise<void>;
}
