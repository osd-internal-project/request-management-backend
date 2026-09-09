/**
 * CM-05 / D-35 — the ONE doorway to the central PDPA service. Consent is that
 * service's data: this module reads it live and renders it, and deliberately
 * has nowhere to write it down (spec: "ห้ามเก็บซ้ำในตาราง contact").
 *
 *   PDPA_MODE=mock (default) — deterministic stand-in until the central
 *                  service (ระยะ 1–2, DPO เป็นเจ้าของ) exists;
 *   PDPA_MODE=http — the real driver; the endpoint shape below is this
 *                  system's proposal for that service's lookup contract.
 */

export const PDPA_CLIENT = 'PDPA_CLIENT';

export type ConsentState = 'granted' | 'none' | 'withdrawn' | 'unknown';

export interface ContactConsentQuery {
  readonly contactId: string;
  readonly email?: string | null;
  readonly phone?: string | null;
}

export interface ContactConsentStatus {
  readonly contactId: string;
  /** ความยินยอมช่องทางอีเมล — `unknown` เมื่อบริการกลางตอบไม่ได้. */
  readonly email: ConsentState | null;
  /** ความยินยอมช่องทางโทรศัพท์. */
  readonly phone: ConsentState | null;
  /** ทะเบียนห้ามโทร (AI SMART ต้องตรวจก่อนโทรทุกสาย — spec PDPA กลาง). */
  readonly doNotCall: boolean;
}

export interface PdpaClient {
  readonly mode: 'mock' | 'http';
  lookupConsents(
    queries: readonly ContactConsentQuery[],
  ): Promise<ContactConsentStatus[]>;
}
