/**
 * D-30 / CM-06 — the ONE doorway to the ERP. Business modules never call the
 * ERP directly (spec §03: "โมดูลธุรกิจไม่เรียกระบบภายนอกโดยตรง ผ่านชั้นนี้ชั้นเดียว");
 * they depend on this interface, and which driver answers is configuration.
 *
 * The ERP is **SAP Business One (B1), on-premise** since 24 ก.ย. 2569 (Odoo
 * dropped). Connect the Dot is the system of record first: data is saved
 * here, then pushed to SAP through the `integration_sync_jobs` queue, so a
 * down SAP never blocks a user.
 *
 *   ERP_MODE=mock   (default) — in-memory stand-in with SAP-shaped answers,
 *                    so every environment runs end-to-end without B1;
 *   ERP_MODE=sapb1  — the B1 Service Layer driver (`sap-b1.client.ts`),
 *                    configured by the ERP_B1_* variables.
 *
 * Every call names the company it is for: in B1 one Connect the Dot company
 * is one company database (CompanyDB), and the driver logs into each apart.
 */

export const ERP_CLIENT = 'ERP_CLIENT';

/**
 * `system` value for the ERP everywhere it is keyed — `customer_external_codes`
 * (the BP number SAP answers) and `integration_sync_jobs` (the retry queue).
 */
export const ERP_SYSTEM = 'sap';

/** Which company a call is for — B1 maps it to a CompanyDB (ERP_B1_COMPANY_DBS). */
export interface ErpContext {
  /** `companies.code`, e.g. `OSD` — readable in config, unlike the uuid. */
  readonly companyCode: string;
}
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

/**
 * CD-89 / C360-02 — one A/R invoice as SAP holds it, read-only. SAP is where
 * every accounting source lands (the 7 accounting-line systems included), so
 * this is the customer's invoice list, not just the ones CTD sent.
 */
export interface ErpInvoice {
  /** B1 `DocNum` — the number accounting quotes. */
  readonly docNo: string;
  /** B1 `NumAtCard` — our SO code when the invoice came from one of ours. */
  readonly reference: string | null;
  /** `YYYY-MM-DD`. */
  readonly issuedOn: string;
  readonly dueOn: string | null;
  readonly currency: string;
  readonly total: number;
  readonly paid: number;
  /** total − paid, never below 0. */
  readonly outstanding: number;
  readonly status: 'open' | 'paid' | 'cancelled';
}

/** One line of a sales order as SAP receives it (CD-88). */
export interface ErpSalesOrderLine {
  readonly lineNo: number;
  /** SAP material — null for a service/labour line. */
  readonly productCode: string | null;
  readonly description: string;
  readonly quantity: number;
  readonly unit: string | null;
  readonly unitPrice: number;
  readonly discountPct: number;
  readonly lineTotal: number;
}

/** What a sale order looks like to SAP (Sales Order, the fields we own). */
export interface ErpSalesOrderPayload {
  /**
   * Our saleOrderCode — carried as SAP's customer reference and the key
   * `findSalesOrder` searches by, the same idempotency guard as customers.
   */
  readonly saleOrderCode: string;
  /** The customer's BP number — the order cannot reach SAP before it. */
  readonly customerExternalCode: string;
  readonly currency: string;
  readonly orderedAt: string;
  /** Before VAT, the sum of the lines. */
  readonly netTotal: number;
  readonly lines: readonly ErpSalesOrderLine[];
}

/**
 * CD-242 — a billed service job as SAP receives it: a **draft** A/R invoice
 * (B1 `Drafts`, `DocObjectCode` oInvoices) that finance checks and posts in
 * SAP. Pending CD-28: the series, the service item and VAT group the finance
 * team want on it.
 */
export interface ErpInvoiceDraftPayload {
  /**
   * Our billing reference — carried as `NumAtCard` and the key the find
   * searches by, so a retry after a timeout adopts the draft it made.
   */
  readonly reference: string;
  readonly customerExternalCode: string;
  readonly currency: string;
  /** YYYY-MM-DD — the document date. */
  readonly issuedOn: string;
  readonly comment: string;
  /** Before VAT, the sum of the lines. */
  readonly netTotal: number;
  readonly lines: readonly ErpSalesOrderLine[];
}

/** CD-242 — where a draft stands in SAP, read back by its reference. */
export interface ErpInvoiceDraftState {
  /**
   * draft — still waiting for finance; open / paid — posted as an A/R
   * invoice; cancelled — the posted invoice was cancelled; missing — neither
   * a draft nor an invoice carries the reference (the draft was deleted).
   */
  readonly status: 'draft' | 'open' | 'paid' | 'cancelled' | 'missing';
  /** B1 `DocNum` of the posted invoice. */
  readonly invoiceNo: string | null;
  readonly total: number | null;
  readonly paid: number | null;
}

/** CD-245 — what one warehouse holds of an item (B1 `ItemWarehouseInfoCollection`). */
export interface ErpStock {
  readonly itemCode: string;
  readonly warehouseCode: string;
  readonly onHand: number;
}

/**
 * CD-245 — spare parts taken out of stock for a service job: a goods issue
 * (B1 `InventoryGenExits`). Pending CD-28: the issue's series, the G/L
 * account the cost lands on, and how serial-managed items are named.
 */
export interface ErpGoodsIssuePayload {
  /** Ours, ≤ 11 chars (B1 `Reference2`) — and the key `findGoodsIssue` uses. */
  readonly reference: string;
  /** YYYY-MM-DD. */
  readonly issuedOn: string;
  readonly comment: string;
  readonly lines: readonly {
    readonly itemCode: string;
    readonly quantity: number;
    readonly warehouseCode: string;
    readonly serialNo: string | null;
  }[];
}

/** CD-27 — one sellable item as SAP holds it (B1 `Items`). */
export interface ErpItem {
  /** B1 `ItemCode` — what quotation/sale-order lines carry as productCode. */
  readonly code: string;
  readonly name: string;
  readonly unit: string | null;
  /** Valid and not frozen — an inactive item cannot go on a new document. */
  readonly active: boolean;
  /** CD-200 — B1 `ItemsGroupCode` and its `ItemGroups.GroupName`. */
  readonly groupCode?: string | null;
  readonly groupName?: string | null;
}

/**
 * CD-142 — a supplier as SAP holds it (B1 `BusinessPartners`, `cSupplier`),
 * read-only. SAP owns the commercial side of a partner; Connect the Dot keeps
 * only the technical profile, keyed by `code`, and never a copy of these.
 */
export interface ErpVendor {
  /** B1 `CardCode`. */
  readonly code: string;
  readonly name: string;
  readonly taxId: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly currency: string | null;
  /** Payment terms by name (B1 `PaymentTermsTypes`), null when none set. */
  readonly paymentTerms: string | null;
  /** Valid and not frozen — a blocked supplier gets no new purchase. */
  readonly active: boolean;
}

/**
 * CD-206 — what a supplier charges for an item, with the date it is from:
 * the last purchase-order line (B1 `PurchaseOrders`) or a special price the
 * supplier holds (B1 `SpecialPrices`). Newest per item × supplier × source.
 */
/**
 * CD-190 — one cost line booked against a project in the ERP (an A/P
 * invoice line carrying the project's code). Pending CD-28: which B1
 * documents the finance team books project costs on.
 */
export interface ErpProjectCost {
  /** Stable identity of the line — `<docType>:<docEntry>:<lineNum>`. */
  readonly key: string;
  readonly docNo: string;
  /** YYYY-MM-DD. */
  readonly postedOn: string;
  readonly itemCode: string | null;
  readonly description: string;
  /** Line total before VAT, in the company's currency. */
  readonly amount: number;
  /** A service line (no stock item) counts as `other`. */
  readonly category: 'material' | 'other';
  readonly vendorName: string | null;
}

export interface ErpVendorCost {
  /** B1 `ItemCode`. */
  readonly itemCode: string;
  /** B1 `CardCode` of the supplier. */
  readonly vendorCode: string;
  readonly vendorName: string | null;
  readonly source: 'purchase_order' | 'special_price';
  /** Per unit, after the line's discount. */
  readonly unitCost: number;
  readonly currency: string;
  /** PO number, or null for a special price. */
  readonly docNo: string | null;
  /** YYYY-MM-DD — the PO's date, or the date a special price starts. */
  readonly costDate: string;
  /** YYYY-MM-DD — a special price's end, when it has one. */
  readonly validTo: string | null;
}

export interface ErpClient {
  readonly mode: 'mock' | 'sapb1';
  /** The BP already carrying this customerCode, or null — idempotency guard. */
  findCustomer(
    ctx: ErpContext,
    customerCode: string,
  ): Promise<{ externalCode: string } | null>;
  createCustomer(
    ctx: ErpContext,
    payload: ErpCustomerPayload,
  ): Promise<{ externalCode: string }>;
  updateCustomer(
    ctx: ErpContext,
    externalCode: string,
    payload: ErpCustomerPayload,
  ): Promise<void>;
  getReceivables(
    ctx: ErpContext,
    externalCode: string,
  ): Promise<ErpReceivables>;
  /** The SAP order already carrying this saleOrderCode, or null. */
  findSalesOrder(
    ctx: ErpContext,
    saleOrderCode: string,
  ): Promise<{ externalCode: string } | null>;
  createSalesOrder(
    ctx: ErpContext,
    payload: ErpSalesOrderPayload,
  ): Promise<{ externalCode: string }>;
  /**
   * Idempotent — cancelling an already-cancelled order succeeds. Takes our
   * saleOrderCode too: B1 cancels by DocEntry, which the driver looks up
   * from it rather than asking callers to store a second SAP key.
   */
  cancelSalesOrder(
    ctx: ErpContext,
    order: { externalCode: string; saleOrderCode: string },
    reason: string,
  ): Promise<void>;
  /** CD-27 — every sellable item, the whole catalog (the driver pages). */
  listItems(ctx: ErpContext): Promise<ErpItem[]>;
  /** CD-142 — every supplier (BP `cSupplier`), the whole list (the driver pages). */
  listVendors(ctx: ErpContext): Promise<ErpVendor[]>;
  /**
   * CD-206 — suppliers' costs: purchase orders dated on or after `since`
   * (YYYY-MM-DD) and every supplier special price. The driver pages.
   */
  listVendorCosts(ctx: ErpContext, since: string): Promise<ErpVendorCost[]>;
  /** CD-190 — every cost line booked against a project code (the driver pages). */
  listProjectCosts(
    ctx: ErpContext,
    projectCode: string,
  ): Promise<ErpProjectCost[]>;
  /** CD-242 — the draft (or the invoice posted from it) carrying `reference`. */
  findInvoiceDraft(
    ctx: ErpContext,
    reference: string,
  ): Promise<{ externalCode: string } | null>;
  createInvoiceDraft(
    ctx: ErpContext,
    payload: ErpInvoiceDraftPayload,
  ): Promise<{ externalCode: string }>;
  invoiceDraftState(
    ctx: ErpContext,
    reference: string,
  ): Promise<ErpInvoiceDraftState>;
  /**
   * Removes a draft finance has not posted; idempotent when it is already
   * gone. A posted invoice is not touched — the call fails, because undoing
   * it is a credit note in SAP, which is finance's to issue.
   */
  cancelInvoiceDraft(ctx: ErpContext, reference: string): Promise<void>;
  /** CD-245 — on-hand quantity per warehouse of these items (≤ 50). */
  listStock(ctx: ErpContext, itemCodes: readonly string[]): Promise<ErpStock[]>;
  /** CD-245 — the goods issue already carrying `reference`, or null. */
  findGoodsIssue(
    ctx: ErpContext,
    reference: string,
  ): Promise<{ externalCode: string } | null>;
  createGoodsIssue(
    ctx: ErpContext,
    payload: ErpGoodsIssuePayload,
  ): Promise<{ externalCode: string }>;
  /** CD-89 — the customer's most recent invoices, newest first (≤ `limit`). */
  listInvoices(
    ctx: ErpContext,
    externalCode: string,
    limit: number,
  ): Promise<ErpInvoice[]>;
}
