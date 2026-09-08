/**
 * D-30 / CM-06 — the ONE doorway to Odoo. Business modules never call Odoo
 * directly (spec §03: "โมดูลธุรกิจไม่เรียกระบบภายนอกโดยตรง ผ่านชั้นนี้ชั้นเดียว");
 * they depend on this interface, and which driver answers is configuration:
 *
 *   ODOO_MODE=mock  (default) — in-memory stand-in, so every environment runs
 *                    end-to-end today, before the team's sandbox exists;
 *   ODOO_MODE=http  — the real JSON-RPC driver, pointed at the sandbox with
 *                    ODOO_BASE_URL / ODOO_DB / ODOO_UID / ODOO_API_KEY.
 *
 * Swapping mock → sandbox is therefore an env change, not a code change.
 */

export const ODOO_CLIENT = 'ODOO_CLIENT';

/** What a customer looks like to Odoo (res.partner, the fields we own). */
export interface OdooPartnerPayload {
  /** Our customerCode — Odoo keys on it (PO decision #1: we issue, Odoo follows). */
  readonly customerCode: string;
  readonly name: string;
  /** เลขผู้เสียภาษี — res.partner `vat`. */
  readonly taxId?: string | null;
  readonly branchCode?: string | null;
  readonly branchName?: string | null;
  readonly email?: string | null;
  readonly phone?: string | null;
  readonly street?: string | null;
  readonly street2?: string | null;
  readonly city?: string | null;
  readonly zip?: string | null;
  /** Mirrors CustomerStatus — a suspended/inactive customer archives in Odoo. */
  readonly active: boolean;
}

/** C360-02 — ยอดค้างชำระ, read from Odoo only, always stamped with asOf. */
export interface OdooReceivables {
  readonly outstanding: number;
  readonly invoiceCount: number;
  readonly asOf: string;
}

export interface OdooClient {
  readonly mode: 'mock' | 'http';
  createPartner(payload: OdooPartnerPayload): Promise<{ partnerId: string }>;
  updatePartner(partnerId: string, payload: OdooPartnerPayload): Promise<void>;
  getReceivables(partnerId: string): Promise<OdooReceivables>;
}
