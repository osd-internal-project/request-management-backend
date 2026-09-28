import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AppError,
  customerAccessSubject,
  visibleCustomersWhere,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import { ERP_CLIENT, ERP_SYSTEM } from '../erp/erp-client';
import type { ErpClient, ErpInvoice } from '../erp/erp-client';
import { CustomerRepository } from './customer.repository';
import { CustomerExternalCodeRepository } from './customer-child.repositories';

/** Enough for "what is open and what just got paid" — older is accounting's job. */
export const INVOICE_LIMIT = 50;
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;

export type InvoiceSource =
  /** Read from SAP just now. */
  | 'live'
  /** ERP_MODE=mock — the numbers would be invented, so none are shown. */
  | 'mock'
  /** The customer has no BP number yet (not pushed to SAP). */
  | 'not_synced'
  /** SAP did not answer — the page still loads (degrade, C360-02). */
  | 'unavailable';

export interface CustomerInvoiceView {
  doc_no: string;
  reference: string | null;
  issued_on: string;
  due_on: string | null;
  currency: string;
  total: number;
  paid: number;
  outstanding: number;
  status: ErpInvoice['status'];
  /** Open and past its due date (Bangkok calendar). */
  overdue: boolean;
}

export interface CustomerInvoices {
  source: InvoiceSource;
  as_of: string | null;
  summary: {
    open_count: number;
    outstanding: number;
    overdue_count: number;
    overdue_amount: number;
  } | null;
  invoices: CustomerInvoiceView[];
}

/**
 * CD-89 / C360-02 — สถานะใบแจ้งหนี้และการรับชำระของลูกค้า อ่านจาก SAP เท่านั้น
 * (read-only ต่อข้อมูลบัญชี). SAP เป็นที่รวมรายการบัญชีจากทุกแหล่ง รวมระบบสาย
 * บัญชี 7 ระบบ — ใบที่ CTD ไม่ได้ส่งไปเองจึงอยู่ในรายการนี้ด้วย.
 *
 * อ่านสดทุกครั้งแทนการ cache: ใบแจ้งหนี้เปลี่ยนสถานะเมื่อรับชำระ และคนที่เปิดแท็บ
 * นี้กำลังจะโทรทวงหรือเตรียมเข้าพบ — ตัวเลขเมื่อชั่วโมงก่อนคือตัวเลขที่ผิด. ยอดรวม
 * บนการ์ด 360° ยังมาจาก cache รายชั่วโมงเหมือนเดิม หน้าหลักจึงไม่รอ SAP.
 *
 * SAP ล่ม = `unavailable` ไม่ใช่ 500 · mock = ไม่แสดงตัวเลข (กฎเดียวกับการ์ด
 * การเงิน: ห้ามโชว์เลขปลอมเหมือนเป็นยอดจริง).
 */
@Injectable()
export class CustomerInvoicesService {
  private readonly logger = new Logger(CustomerInvoicesService.name);

  constructor(
    private readonly customers: CustomerRepository,
    private readonly externalCodes: CustomerExternalCodeRepository,
    @Inject(ERP_CLIENT) private readonly erp: ErpClient,
  ) {}

  async list(
    customerId: string,
    actor: Principal,
    now: Date = new Date(),
  ): Promise<CustomerInvoices> {
    const customer = (await this.customers.findFirst({
      where: {
        id: customerId,
        AND: [visibleCustomersWhere(customerAccessSubject(actor))],
      },
      select: { id: true, company: { select: { code: true } } },
    })) as { id: string; company: { code: string } } | null;
    // SCOPE-03: out of reach answers 404, not 403.
    if (!customer) throw new AppError('NOT_FOUND', 'ไม่พบลูกค้าที่ระบุ');

    const empty = (source: InvoiceSource): CustomerInvoices => ({
      source,
      as_of: null,
      summary: null,
      invoices: [],
    });

    if (this.erp.mode === 'mock') return empty('mock');

    const link = (await this.externalCodes.findFirst({
      where: { customerId, system: ERP_SYSTEM },
      select: { externalCode: true },
    })) as { externalCode: string } | null;
    if (!link) return empty('not_synced');

    let rows: ErpInvoice[];
    try {
      rows = await this.erp.listInvoices(
        { companyCode: customer.company.code },
        link.externalCode,
        INVOICE_LIMIT,
      );
    } catch (error) {
      this.logger.warn(
        `invoices for ${customerId} unavailable: ${(error as Error).message}`,
      );
      return empty('unavailable');
    }

    const today = new Date(now.getTime() + BANGKOK_OFFSET_MS)
      .toISOString()
      .slice(0, 10);
    const invoices = rows.map((row) => ({
      doc_no: row.docNo,
      reference: row.reference,
      issued_on: row.issuedOn,
      due_on: row.dueOn,
      currency: row.currency,
      total: row.total,
      paid: row.paid,
      outstanding: row.outstanding,
      status: row.status,
      overdue: row.status === 'open' && row.dueOn !== null && row.dueOn < today,
    }));

    const open = invoices.filter((row) => row.status === 'open');
    const overdue = open.filter((row) => row.overdue);
    const sum = (list: CustomerInvoiceView[]) =>
      Math.round(
        list.reduce((total, row) => total + row.outstanding, 0) * 100,
      ) / 100;

    return {
      source: 'live',
      as_of: now.toISOString(),
      summary: {
        open_count: open.length,
        outstanding: sum(open),
        overdue_count: overdue.length,
        overdue_amount: sum(overdue),
      },
      invoices,
    };
  }
}
