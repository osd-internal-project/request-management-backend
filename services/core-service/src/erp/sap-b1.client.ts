import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppError } from '@request-management/share';
import {
  ErpClient,
  ErpContext,
  ErpCustomerPayload,
  ErpInvoice,
  ErpItem,
  ErpProjectCost,
  ErpVendor,
  ErpVendorCost,
  ErpReceivables,
  ErpSalesOrderPayload,
} from './erp-client';
import { B1_TRANSPORT } from './sap-b1.transport';
import type { B1Request, B1Response, B1Transport } from './sap-b1.transport';

/** B1 `OCRD.CardCode` is nvarchar(15) — our customerCode must fit as-is. */
const CARD_CODE_MAX = 15;

/** Rows per `/Items` page, and a ceiling so a looping nextLink cannot spin. */
const ITEMS_PAGE_SIZE = 500;
const ITEMS_MAX_PAGES = 200;

export interface SapB1Settings {
  /** Service Layer root, e.g. `https://b1.osd.local:50000/b1s/v1`. */
  readonly baseUrl: string;
  readonly username: string;
  readonly password: string;
  /** `companies.code` → B1 CompanyDB, from ERP_B1_COMPANY_DBS. */
  readonly companyDbs: Record<string, string>;
  /** ItemCode for a line with no product code (service/labour). */
  readonly serviceItemCode?: string;
  readonly warehouseCode?: string;
  readonly vatGroup?: string;
}

interface Session {
  cookie: string;
  timeoutMs: number;
  expiresAt: number;
}

/**
 * The real driver (ERP_MODE=sapb1) — SAP Business One Service Layer
 * (REST/OData v1), on-premise. Nothing outside this file knows B1's shapes:
 *
 *   ลูกค้า     → BusinessPartners, CardCode = our customerCode (B1 lets the
 *               caller choose it, so PO decision #1 holds with no mapping);
 *   ใบสั่งขาย  → Orders, NumAtCard = our saleOrderCode (the idempotency key),
 *               externalCode = DocNum (what people see in B1);
 *   ยกเลิก     → Orders(DocEntry)/Cancel, DocEntry looked up by NumAtCard;
 *   ยอดค้าง    → BusinessPartners.CurrentAccountBalance + open-invoice count.
 *
 * One session per CompanyDB, kept until B1's SessionTimeout and renewed on a
 * 401 once. Field mapping is the starting point agreed in CD-28, not a settled
 * contract — Thai branch/VAT fields depend on the B1 localization in use.
 */
@Injectable()
export class SapB1Client implements ErpClient {
  readonly mode = 'sapb1' as const;
  private readonly logger = new Logger(SapB1Client.name);
  private readonly sessions = new Map<string, Session>();
  private readonly logins = new Map<string, Promise<Session>>();
  private readonly settings: SapB1Settings;

  constructor(
    config: ConfigService,
    @Inject(B1_TRANSPORT) private readonly transport: B1Transport,
  ) {
    this.settings = config.get<SapB1Settings>('erp.b1') as SapB1Settings;
  }

  /** Boot-time check — ERP_MODE=sapb1 with half a config fails loudly. */
  static missingSettings(
    settings: Partial<SapB1Settings> | undefined,
  ): string[] {
    const missing: string[] = [];
    if (!settings?.baseUrl) missing.push('ERP_B1_BASE_URL');
    if (!settings?.username) missing.push('ERP_B1_USERNAME');
    if (!settings?.password) missing.push('ERP_B1_PASSWORD');
    if (!Object.keys(settings?.companyDbs ?? {}).length) {
      missing.push('ERP_B1_COMPANY_DBS');
    }
    return missing;
  }

  // --- ลูกค้า ---------------------------------------------------------------

  async findCustomer(
    ctx: ErpContext,
    customerCode: string,
  ): Promise<{ externalCode: string } | null> {
    const res = await this.call(
      ctx,
      'GET',
      `/BusinessPartners(${key(customerCode)})?$select=CardCode`,
    );
    if (res.status === 404) return null;
    const bp = this.json<{ CardCode: string }>(res, 'ค้นลูกค้า');
    return { externalCode: bp.CardCode };
  }

  async createCustomer(
    ctx: ErpContext,
    payload: ErpCustomerPayload,
  ): Promise<{ externalCode: string }> {
    if (payload.customerCode.length > CARD_CODE_MAX) {
      throw new AppError(
        'UPSTREAM_ERROR',
        `รหัสลูกค้า ${payload.customerCode} ยาวเกิน ${CARD_CODE_MAX} ตัวอักษร — SAP B1 (CardCode) รับไม่ได้`,
      );
    }
    const res = await this.call(ctx, 'POST', '/BusinessPartners', {
      CardCode: payload.customerCode,
      CardType: 'cCustomer',
      ...toBusinessPartner(payload),
    });
    const bp = this.json<{ CardCode: string }>(res, 'สร้างลูกค้า');
    return { externalCode: bp.CardCode };
  }

  async updateCustomer(
    ctx: ErpContext,
    externalCode: string,
    payload: ErpCustomerPayload,
  ): Promise<void> {
    const res = await this.call(
      ctx,
      'PATCH',
      `/BusinessPartners(${key(externalCode)})`,
      toBusinessPartner(payload),
    );
    this.ok(res, 'แก้ไขลูกค้า');
  }

  async getReceivables(
    ctx: ErpContext,
    externalCode: string,
  ): Promise<ErpReceivables> {
    const [bpRes, countRes] = await Promise.all([
      this.call(
        ctx,
        'GET',
        `/BusinessPartners(${key(externalCode)})?$select=CurrentAccountBalance`,
      ),
      this.call(
        ctx,
        'GET',
        `/Invoices/$count?$filter=${q(
          `CardCode eq ${literal(externalCode)} and DocumentStatus eq 'bost_Open'`,
        )}`,
      ),
    ]);
    const bp = this.json<{ CurrentAccountBalance: number }>(
      bpRes,
      'อ่านยอดค้าง',
    );
    this.ok(countRes, 'นับใบแจ้งหนี้');

    return {
      outstanding: Number(bp.CurrentAccountBalance ?? 0),
      invoiceCount: Number(countRes.body.trim()) || 0,
      asOf: new Date().toISOString(),
    };
  }

  // --- ใบสั่งขาย -------------------------------------------------------------

  async findSalesOrder(
    ctx: ErpContext,
    saleOrderCode: string,
  ): Promise<{ externalCode: string } | null> {
    const order = await this.orderByCode(ctx, saleOrderCode);
    return order ? { externalCode: String(order.DocNum) } : null;
  }

  async createSalesOrder(
    ctx: ErpContext,
    payload: ErpSalesOrderPayload,
  ): Promise<{ externalCode: string }> {
    const { serviceItemCode, warehouseCode, vatGroup } = this.settings;
    const date = bangkokDate(payload.orderedAt);

    const lines = payload.lines.map((line) => {
      const itemCode = line.productCode ?? serviceItemCode;
      if (!itemCode) {
        throw new AppError(
          'UPSTREAM_ERROR',
          `บรรทัด ${line.lineNo} ไม่มีรหัสสินค้า และยังไม่ได้ตั้ง ERP_B1_SERVICE_ITEM สำหรับบรรทัดบริการ`,
        );
      }
      return {
        ItemCode: itemCode,
        ItemDescription: line.description.slice(0, 100),
        Quantity: line.quantity,
        UnitPrice: line.unitPrice,
        DiscountPercent: line.discountPct,
        ...(warehouseCode ? { WarehouseCode: warehouseCode } : {}),
        ...(vatGroup ? { VatGroup: vatGroup } : {}),
      };
    });

    // DocCurrency is left to the BP's currency: sending "THB" where B1's local
    // currency symbol differs would be rejected for no business reason.
    const res = await this.call(ctx, 'POST', '/Orders', {
      CardCode: payload.customerExternalCode,
      NumAtCard: payload.saleOrderCode,
      DocDate: date,
      DocDueDate: date,
      Comments: `Connect the Dot ${payload.saleOrderCode}`,
      DocumentLines: lines,
    });
    const order = this.json<{ DocEntry: number; DocNum: number }>(
      res,
      'สร้างใบสั่งขาย',
    );
    return { externalCode: String(order.DocNum) };
  }

  async cancelSalesOrder(
    ctx: ErpContext,
    target: { externalCode: string; saleOrderCode: string },
    reason: string,
  ): Promise<void> {
    const order = await this.orderByCode(ctx, target.saleOrderCode);
    if (!order) {
      throw new AppError(
        'UPSTREAM_ERROR',
        `ไม่พบใบสั่งขาย ${target.saleOrderCode} (DocNum ${target.externalCode}) ใน SAP B1`,
      );
    }
    if (order.Cancelled === 'tYES') return;

    const res = await this.call(
      ctx,
      'POST',
      `/Orders(${order.DocEntry})/Cancel`,
    );
    this.ok(res, `ยกเลิกใบสั่งขาย (${reason})`);
  }

  // --- สินค้า (CD-27) ---------------------------------------------------------

  /**
   * Sellable items, all pages: Service Layer answers 20 rows by default, so
   * ask for ITEMS_PAGE_SIZE and follow `odata.nextLink` to the end.
   */
  /**
   * CD-89 — A/R invoices of one BP, newest first. `DocumentStatus` says open
   * or closed; `Cancelled` marks a document reversed by a cancellation, which
   * B1 also closes — so cancelled is checked first.
   */
  async listInvoices(
    ctx: ErpContext,
    externalCode: string,
    limit: number,
  ): Promise<ErpInvoice[]> {
    const select =
      'DocNum,NumAtCard,DocDate,DocDueDate,DocCurrency,DocTotal,PaidToDate,DocumentStatus,Cancelled';
    const res = await this.call(
      ctx,
      'GET',
      `/Invoices?$select=${select}&$filter=${q(
        `CardCode eq ${literal(externalCode)}`,
      )}&$orderby=${q('DocDate desc,DocNum desc')}&$top=${limit}`,
    );
    const rows = this.json<{
      value: {
        DocNum: number;
        NumAtCard: string | null;
        DocDate: string;
        DocDueDate: string | null;
        DocCurrency: string | null;
        DocTotal: number;
        PaidToDate: number;
        DocumentStatus: string;
        Cancelled: string;
      }[];
    }>(res, 'อ่านใบแจ้งหนี้').value;

    return rows.map((row) => {
      const total = Number(row.DocTotal ?? 0);
      const paid = Number(row.PaidToDate ?? 0);
      const cancelled = row.Cancelled === 'tYES';
      return {
        docNo: String(row.DocNum),
        reference: row.NumAtCard || null,
        issuedOn: row.DocDate.slice(0, 10),
        dueOn: row.DocDueDate ? row.DocDueDate.slice(0, 10) : null,
        currency: row.DocCurrency || 'THB',
        total,
        paid,
        // A cancelled invoice owes nothing, whatever PaidToDate says.
        outstanding: cancelled
          ? 0
          : Math.max(0, Math.round((total - paid) * 100) / 100),
        status: cancelled
          ? 'cancelled'
          : row.DocumentStatus === 'bost_Open'
            ? 'open'
            : 'paid',
      };
    });
  }

  async listItems(ctx: ErpContext): Promise<ErpItem[]> {
    // CD-200 — item groups by number; a short list, read once per sync.
    const groupsRes = await this.call(
      ctx,
      'GET',
      '/ItemGroups?$select=Number,GroupName',
    );
    const groups = new Map(
      this.json<{ value: { Number: number; GroupName: string | null }[] }>(
        groupsRes,
        'อ่านกลุ่มสินค้า',
      ).value.map((row) => [row.Number, row.GroupName?.trim() || null]),
    );
    const items: ErpItem[] = [];
    let path: string | null =
      `/Items?$select=ItemCode,ItemName,SalesUnit,Valid,Frozen,ItemsGroupCode&$filter=${q(
        "SalesItem eq 'tYES'",
      )}&$orderby=ItemCode`;

    for (let page = 0; path && page < ITEMS_MAX_PAGES; page += 1) {
      const res = await this.call(ctx, 'GET', path, undefined, {
        Prefer: `odata.maxpagesize=${ITEMS_PAGE_SIZE}`,
      });
      const body = this.json<{
        value: {
          ItemCode: string;
          ItemName: string | null;
          SalesUnit: string | null;
          Valid: string;
          Frozen: string;
          ItemsGroupCode?: number | null;
        }[];
        'odata.nextLink'?: string;
        '@odata.nextLink'?: string;
      }>(res, 'อ่านรายการสินค้า');

      for (const row of body.value) {
        items.push({
          code: row.ItemCode,
          name: row.ItemName?.trim() || row.ItemCode,
          unit: row.SalesUnit?.trim() || null,
          active: row.Valid !== 'tNO' && row.Frozen !== 'tYES',
          groupCode:
            row.ItemsGroupCode === null || row.ItemsGroupCode === undefined
              ? null
              : String(row.ItemsGroupCode),
          groupName:
            row.ItemsGroupCode === null || row.ItemsGroupCode === undefined
              ? null
              : (groups.get(row.ItemsGroupCode) ?? null),
        });
      }
      path = nextPath(body['odata.nextLink'] ?? body['@odata.nextLink']);
    }
    return items;
  }

  async listVendors(ctx: ErpContext): Promise<ErpVendor[]> {
    // Payment terms come as a group number; their names are a short list.
    const termsRes = await this.call(
      ctx,
      'GET',
      '/PaymentTermsTypes?$select=GroupNumber,PaymentTermsGroupName',
    );
    const terms = new Map(
      this.json<{
        value: { GroupNumber: number; PaymentTermsGroupName: string | null }[];
      }>(termsRes, 'อ่านเงื่อนไขการชำระเงิน').value.map((row) => [
        row.GroupNumber,
        row.PaymentTermsGroupName?.trim() || null,
      ]),
    );

    const vendors: ErpVendor[] = [];
    let path: string | null =
      `/BusinessPartners?$select=CardCode,CardName,FederalTaxID,Phone1,EmailAddress,Currency,PayTermsGrpCode,Valid,Frozen&$filter=${q(
        "CardType eq 'cSupplier'",
      )}&$orderby=CardCode`;

    for (let page = 0; path && page < ITEMS_MAX_PAGES; page += 1) {
      const res = await this.call(ctx, 'GET', path, undefined, {
        Prefer: `odata.maxpagesize=${ITEMS_PAGE_SIZE}`,
      });
      const body = this.json<{
        value: {
          CardCode: string;
          CardName: string | null;
          FederalTaxID: string | null;
          Phone1: string | null;
          EmailAddress: string | null;
          Currency: string | null;
          PayTermsGrpCode: number | null;
          Valid: string;
          Frozen: string;
        }[];
        'odata.nextLink'?: string;
        '@odata.nextLink'?: string;
      }>(res, 'อ่านรายชื่อผู้ขาย');

      for (const row of body.value) {
        vendors.push({
          code: row.CardCode,
          name: row.CardName?.trim() || row.CardCode,
          taxId: row.FederalTaxID?.trim() || null,
          phone: row.Phone1?.trim() || null,
          email: row.EmailAddress?.trim() || null,
          // `##` is B1's "all currencies".
          currency: row.Currency && row.Currency !== '##' ? row.Currency : null,
          paymentTerms:
            row.PayTermsGrpCode !== null && row.PayTermsGrpCode !== undefined
              ? (terms.get(row.PayTermsGrpCode) ?? null)
              : null,
          active: row.Valid !== 'tNO' && row.Frozen !== 'tYES',
        });
      }
      path = nextPath(body['odata.nextLink'] ?? body['@odata.nextLink']);
    }
    return vendors;
  }

  /**
   * CD-206 — suppliers' costs.
   *
   *   - Purchase orders dated on/after `since`, not cancelled, newest first:
   *     each line's `Price` (per unit, after the line discount) in the line's
   *     currency; the first seen per item × supplier is the latest.
   *   - Special prices (`SpecialPrices`) of suppliers only — the entity holds
   *     customers' too. A price with date ranges takes the range covering
   *     today (else the latest to start) and its `DateFrom`; one without
   *     ranges is standing, dated today.
   *
   * Field names follow the Service Layer reference; confirm against the
   * company's B1 with its team (CD-28).
   */
  /**
   * CD-190 — A/P invoices whose header carries the project code, every line
   * (the header filter is what B1's OData can do; a line booked to another
   * project inside such an invoice is skipped). Which documents finance
   * books project costs on is still to be confirmed with the B1 team (CD-28).
   */
  async listProjectCosts(
    ctx: ErpContext,
    projectCode: string,
  ): Promise<ErpProjectCost[]> {
    const costs: ErpProjectCost[] = [];
    let path: string | null =
      `/PurchaseInvoices?$select=DocEntry,DocNum,DocDate,CardName,Project,DocumentLines&$filter=${q(
        `Project eq ${literal(projectCode)} and Cancelled eq 'tNO'`,
      )}&$orderby=DocDate desc,DocNum desc`;
    for (let page = 0; path && page < ITEMS_MAX_PAGES; page += 1) {
      const res = await this.call(ctx, 'GET', path, undefined, {
        Prefer: `odata.maxpagesize=${ITEMS_PAGE_SIZE}`,
      });
      const body = this.json<{
        value: {
          DocEntry: number;
          DocNum: number;
          DocDate: string;
          CardName: string | null;
          Project: string | null;
          DocumentLines: {
            LineNum: number;
            ItemCode: string | null;
            ItemDescription: string | null;
            LineTotal: number | null;
            ProjectCode: string | null;
          }[];
        }[];
        'odata.nextLink'?: string;
        '@odata.nextLink'?: string;
      }>(res, 'อ่านต้นทุนโครงการ');
      for (const doc of body.value) {
        for (const line of doc.DocumentLines ?? []) {
          if (line.ProjectCode && line.ProjectCode !== projectCode) continue;
          if (line.LineTotal === null || line.LineTotal === undefined) continue;
          costs.push({
            key: `PCH:${doc.DocEntry}:${line.LineNum}`,
            docNo: String(doc.DocNum),
            postedOn: doc.DocDate.slice(0, 10),
            itemCode: line.ItemCode,
            description:
              line.ItemDescription?.trim() ||
              line.ItemCode ||
              `AP ${doc.DocNum}`,
            amount: line.LineTotal,
            category: line.ItemCode ? 'material' : 'other',
            vendorName: doc.CardName?.trim() || null,
          });
        }
      }
      path = nextPath(body['odata.nextLink'] ?? body['@odata.nextLink']);
    }
    return costs;
  }

  async listVendorCosts(
    ctx: ErpContext,
    since: string,
  ): Promise<ErpVendorCost[]> {
    const today = new Date().toISOString().slice(0, 10);
    const vendors = new Map(
      (await this.listVendors(ctx)).map((vendor) => [vendor.code, vendor.name]),
    );
    const costs: ErpVendorCost[] = [];
    const seen = new Set<string>();

    let path: string | null =
      `/PurchaseOrders?$select=DocNum,DocDate,CardCode,CardName,DocCurrency,DocumentLines&$filter=${q(
        `DocDate ge ${literal(since)} and Cancelled eq 'tNO'`,
      )}&$orderby=DocDate desc,DocNum desc`;
    for (let page = 0; path && page < ITEMS_MAX_PAGES; page += 1) {
      const res = await this.call(ctx, 'GET', path, undefined, {
        Prefer: `odata.maxpagesize=${ITEMS_PAGE_SIZE}`,
      });
      const body = this.json<{
        value: {
          DocNum: number;
          DocDate: string;
          CardCode: string;
          CardName: string | null;
          DocCurrency: string | null;
          DocumentLines: {
            ItemCode: string | null;
            Price: number | null;
            Currency: string | null;
          }[];
        }[];
        'odata.nextLink'?: string;
        '@odata.nextLink'?: string;
      }>(res, 'อ่านใบสั่งซื้อ');
      for (const order of body.value) {
        for (const line of order.DocumentLines ?? []) {
          if (!line.ItemCode || line.Price === null || line.Price === undefined)
            continue;
          const key = `${line.ItemCode}|${order.CardCode}`;
          if (seen.has(key)) continue;
          seen.add(key);
          costs.push({
            itemCode: line.ItemCode,
            vendorCode: order.CardCode,
            vendorName:
              order.CardName?.trim() || vendors.get(order.CardCode) || null,
            source: 'purchase_order',
            unitCost: line.Price,
            currency: line.Currency || order.DocCurrency || 'THB',
            docNo: String(order.DocNum),
            costDate: order.DocDate.slice(0, 10),
            validTo: null,
          });
        }
      }
      path = nextPath(body['odata.nextLink'] ?? body['@odata.nextLink']);
    }

    path = `/SpecialPrices?$select=ItemCode,CardCode,Price,Currency,SpecialPriceDataAreas`;
    for (let page = 0; path && page < ITEMS_MAX_PAGES; page += 1) {
      const res = await this.call(ctx, 'GET', path, undefined, {
        Prefer: `odata.maxpagesize=${ITEMS_PAGE_SIZE}`,
      });
      const body = this.json<{
        value: {
          ItemCode: string;
          CardCode: string;
          Price: number | null;
          Currency: string | null;
          SpecialPriceDataAreas?: {
            DateFrom: string | null;
            Dateto: string | null;
            SpecialPrice: number | null;
            PriceCurrency?: string | null;
          }[];
        }[];
        'odata.nextLink'?: string;
        '@odata.nextLink'?: string;
      }>(res, 'อ่านราคาพิเศษของผู้ขาย');
      for (const row of body.value) {
        if (!vendors.has(row.CardCode)) continue;
        const areas = (row.SpecialPriceDataAreas ?? []).filter(
          (area) => area.SpecialPrice !== null && area.DateFrom,
        );
        const area =
          areas.find(
            (one) =>
              one.DateFrom!.slice(0, 10) <= today &&
              (!one.Dateto || one.Dateto.slice(0, 10) >= today),
          ) ?? areas.sort((a, b) => b.DateFrom!.localeCompare(a.DateFrom!))[0];
        const unitCost = area ? area.SpecialPrice : row.Price;
        if (unitCost === null || unitCost === undefined) continue;
        costs.push({
          itemCode: row.ItemCode,
          vendorCode: row.CardCode,
          vendorName: vendors.get(row.CardCode) ?? null,
          source: 'special_price',
          unitCost,
          currency: area?.PriceCurrency || row.Currency || 'THB',
          docNo: null,
          costDate: area ? area.DateFrom!.slice(0, 10) : today,
          validTo: area?.Dateto ? area.Dateto.slice(0, 10) : null,
        });
      }
      path = nextPath(body['odata.nextLink'] ?? body['@odata.nextLink']);
    }
    return costs;
  }

  private async orderByCode(
    ctx: ErpContext,
    saleOrderCode: string,
  ): Promise<{ DocEntry: number; DocNum: number; Cancelled: string } | null> {
    const res = await this.call(
      ctx,
      'GET',
      `/Orders?$select=DocEntry,DocNum,Cancelled&$filter=${q(
        `NumAtCard eq ${literal(saleOrderCode)}`,
      )}`,
    );
    const body = this.json<{
      value: { DocEntry: number; DocNum: number; Cancelled: string }[];
    }>(res, 'ค้นใบสั่งขาย');
    return body.value[0] ?? null;
  }

  // --- session + wire --------------------------------------------------------

  private async call(
    ctx: ErpContext,
    method: B1Request['method'],
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
    retried = false,
  ): Promise<B1Response> {
    const companyDb = this.companyDb(ctx);
    const session = await this.session(companyDb);

    const res = await this.transport.send({
      method,
      url: `${this.settings.baseUrl.replace(/\/$/, '')}${path}`,
      headers: {
        ...headers,
        Cookie: session.cookie,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    // B1 dropped the session (timeout, restart) — log in again, once.
    if (res.status === 401 && !retried) {
      this.sessions.delete(companyDb);
      return this.call(ctx, method, path, body, headers, true);
    }

    session.expiresAt = Date.now() + session.timeoutMs;
    return res;
  }

  private companyDb(ctx: ErpContext): string {
    const db = this.settings.companyDbs[ctx.companyCode];
    if (!db) {
      throw new AppError(
        'UPSTREAM_ERROR',
        `ยังไม่ได้ผูกบริษัท ${ctx.companyCode} กับ CompanyDB ของ SAP B1 (ERP_B1_COMPANY_DBS)`,
      );
    }
    return db;
  }

  private async session(companyDb: string): Promise<Session> {
    const current = this.sessions.get(companyDb);
    if (current && current.expiresAt > Date.now()) return current;

    // Concurrent calls share one login instead of each opening a session.
    let pending = this.logins.get(companyDb);
    if (!pending) {
      pending = this.login(companyDb).finally(() =>
        this.logins.delete(companyDb),
      );
      this.logins.set(companyDb, pending);
    }
    return pending;
  }

  private async login(companyDb: string): Promise<Session> {
    const res = await this.transport.send({
      method: 'POST',
      url: `${this.settings.baseUrl.replace(/\/$/, '')}/Login`,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        CompanyDB: companyDb,
        UserName: this.settings.username,
        Password: this.settings.password,
      }),
    });
    const body = this.json<{ SessionTimeout?: number }>(res, 'เข้าสู่ระบบ');

    // B1SESSION identifies the session; ROUTEID pins it to one node behind
    // the Service Layer load balancer. Both go back on every call.
    const cookie = cookiesOf(res)
      .filter((c) => /^(B1SESSION|ROUTEID)=/.test(c))
      .join('; ');
    if (!cookie.includes('B1SESSION=')) {
      throw new AppError(
        'UPSTREAM_ERROR',
        'SAP B1 ไม่ส่ง B1SESSION กลับมาตอนเข้าสู่ระบบ',
      );
    }

    // Renew a minute early rather than race the server's own expiry.
    const timeoutMs = Math.max((body.SessionTimeout ?? 30) - 1, 1) * 60_000;
    const session = { cookie, timeoutMs, expiresAt: Date.now() + timeoutMs };
    this.sessions.set(companyDb, session);
    this.logger.log(`SAP B1 login ${companyDb}`);
    return session;
  }

  private ok(res: B1Response, what: string): void {
    if (res.status >= 400) {
      const detail = errorText(res);
      this.logger.warn(`SAP B1 ${what} failed (${res.status}): ${detail}`);
      throw new AppError(
        'UPSTREAM_ERROR',
        `SAP B1 ${what}ไม่สำเร็จ (${res.status}): ${detail}`,
      );
    }
  }

  private json<T>(res: B1Response, what: string): T {
    this.ok(res, what);
    return JSON.parse(res.body) as T;
  }
}

function toBusinessPartner(payload: ErpCustomerPayload) {
  const hasAddress = Boolean(payload.street || payload.city || payload.zip);
  return {
    CardName: payload.name.slice(0, 100),
    FederalTaxID: payload.taxId ?? undefined,
    EmailAddress: payload.email ?? undefined,
    Phone1: payload.phone?.slice(0, 20) ?? undefined,
    // Suspended/inactive in CTD = frozen in B1 (kept, but no new documents).
    Frozen: payload.active ? 'tNO' : 'tYES',
    ...(hasAddress
      ? {
          BPAddresses: [
            {
              AddressName: 'BILL_TO',
              AddressType: 'bo_BillTo',
              Street: payload.street ?? undefined,
              Block: payload.street2 ?? undefined,
              City: payload.city ?? undefined,
              ZipCode: payload.zip ?? undefined,
              Country: 'TH',
            },
          ],
        }
      : {}),
  };
}

/** OData key literal: `'CUS-OSD-000001'`, quotes doubled, URL-safe. */
function key(value: string): string {
  return encodeURIComponent(literal(value));
}

function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Query-string value — `encodeURIComponent`, never `+` for spaces. */
function q(value: string): string {
  return encodeURIComponent(value);
}

/** B1 document dates are calendar dates; ours are instants — use Bangkok's day. */
function bangkokDate(iso: string): string {
  return new Date(new Date(iso).getTime() + 7 * 3_600_000)
    .toISOString()
    .slice(0, 10);
}

/**
 * `odata.nextLink` → a path under the Service Layer root. v1 answers it
 * relative (`Items?…&$skip=500`), some builds absolute (`/b1s/v1/Items?…`).
 */
function nextPath(link: string | undefined): string | null {
  if (!link) return null;
  const at = link.indexOf('/b1s/');
  const rest = at >= 0 ? link.slice(link.indexOf('/', at + 5)) : link;
  return rest.startsWith('/') ? rest : `/${rest}`;
}

function cookiesOf(res: B1Response): string[] {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.map((c) => c.split(';')[0].trim());
}

/** Service Layer v1 nests the text in `message.value`; v2 gives a string. */
function errorText(res: B1Response): string {
  try {
    const body = JSON.parse(res.body) as {
      error?: { code?: unknown; message?: string | { value?: string } };
    };
    const message = body.error?.message;
    const text = typeof message === 'string' ? message : message?.value;
    return text ?? res.body.slice(0, 300);
  } catch {
    return res.body.slice(0, 300) || 'ไม่มีรายละเอียด';
  }
}
