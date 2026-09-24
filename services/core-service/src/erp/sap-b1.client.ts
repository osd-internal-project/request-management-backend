import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppError } from '@request-management/share';
import {
  ErpClient,
  ErpContext,
  ErpCustomerPayload,
  ErpReceivables,
  ErpSalesOrderPayload,
} from './erp-client';
import { B1_TRANSPORT } from './sap-b1.transport';
import type { B1Request, B1Response, B1Transport } from './sap-b1.transport';

/** B1 `OCRD.CardCode` is nvarchar(15) — our customerCode must fit as-is. */
const CARD_CODE_MAX = 15;

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
    retried = false,
  ): Promise<B1Response> {
    const companyDb = this.companyDb(ctx);
    const session = await this.session(companyDb);

    const res = await this.transport.send({
      method,
      url: `${this.settings.baseUrl.replace(/\/$/, '')}${path}`,
      headers: {
        Cookie: session.cookie,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    // B1 dropped the session (timeout, restart) — log in again, once.
    if (res.status === 401 && !retried) {
      this.sessions.delete(companyDb);
      return this.call(ctx, method, path, body, true);
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
