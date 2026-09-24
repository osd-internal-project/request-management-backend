/**
 * D-30 / CM-06 — the ONE doorway to the ERP. Business modules never call the
 * ERP directly (spec §03: "โมดูลธุรกิจไม่เรียกระบบภายนอกโดยตรง ผ่านชั้นนี้ชั้นเดียว");
 * they depend on this interface, and which driver answers is configuration.
 *
 * The ERP is **SAP** since 24 ก.ย. 2569 (Odoo dropped). Connect the Dot is the
 * system of record first: data is saved here, then pushed to SAP through the
 * `integration_sync_jobs` queue, so a down SAP never blocks a user.
 *
 *   ERP_MODE=mock  (default, the only driver today) — in-memory stand-in with
 *                   SAP-shaped answers (Business Partner numbers), so every
 *                   environment runs end-to-end before the connection exists.
 *
 * The real driver lands once the SAP team settles version + method (S/4HANA
 * OData `API_BUSINESS_PARTNER` or BAPI/RFC); swapping mock → SAP will be an
 * env change, not a code change outside `erp/`.
 */

export const ERP_CLIENT = 'ERP_CLIENT';

/**
 * `system` value for the ERP everywhere it is keyed — `customer_external_codes`
 * (the BP number SAP answers) and `integration_sync_jobs` (the retry queue).
 */
export const ERP_SYSTEM = 'sap';

/** What a customer looks like to SAP (Business Partner, the fields we own). */
export interface ErpCustomerPayload {
  /**
   * Our customerCode — PO decision #1: we issue, the ERP follows. Also the key
   * `findCustomer` searches by, so a retry after a timeout adopts the BP the
   * first attempt created instead of making a second one.
   */
  readonly customerCode: string;
  readonly name: string;
  /** เลขผู้เสียภาษี. */
  readonly taxId?: string | null;
  readonly branchCode?: string | null;
  readonly branchName?: string | null;
  readonly email?: string | null;
  readonly phone?: string | null;
  readonly street?: string | null;
  readonly street2?: string | null;
  readonly city?: string | null;
  readonly zip?: string | null;
  /** Mirrors CustomerStatus — a suspended/inactive customer is blocked in SAP. */
  readonly active: boolean;
}

/** C360-02 — ยอดค้างชำระ, read from the ERP only, always stamped with asOf. */
export interface ErpReceivables {
  readonly outstanding: number;
  readonly invoiceCount: number;
  readonly asOf: string;
}

export interface ErpClient {
  readonly mode: 'mock';
  /** The BP already carrying this customerCode, or null — idempotency guard. */
  findCustomer(customerCode: string): Promise<{ externalCode: string } | null>;
  createCustomer(
    payload: ErpCustomerPayload,
  ): Promise<{ externalCode: string }>;
  updateCustomer(
    externalCode: string,
    payload: ErpCustomerPayload,
  ): Promise<void>;
  getReceivables(externalCode: string): Promise<ErpReceivables>;
}
