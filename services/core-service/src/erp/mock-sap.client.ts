import { Injectable, Logger } from '@nestjs/common';
import {
  ErpClient,
  ErpContext,
  ErpCustomerPayload,
  ErpInvoice,
  ErpItem,
  ErpReceivables,
  ErpSalesOrderPayload,
  ErpVendor,
} from './erp-client';

/**
 * The stand-in driver (ERP_MODE=mock, the default until the SAP connection
 * exists). Answers look like SAP's — a 10-digit Business Partner number,
 * prefixed `MOCK-` so nobody mistakes it for a real one. Deterministic on
 * purpose: the same customer always gets the same BP and the same receivable
 * figures, so a UAT walkthrough is repeatable and a screenshot reproducible.
 */
@Injectable()
export class MockSapClient implements ErpClient {
  readonly mode = 'mock' as const;
  private readonly logger = new Logger(MockSapClient.name);
  private readonly partners = new Map<string, ErpCustomerPayload>();
  private readonly orders = new Map<
    string,
    { payload: ErpSalesOrderPayload; cancelled: boolean }
  >();

  findCustomer(
    _ctx: ErpContext,
    customerCode: string,
  ): Promise<{ externalCode: string } | null> {
    const externalCode = bpOf(customerCode);
    return Promise.resolve(
      this.partners.has(externalCode) ? { externalCode } : null,
    );
  }

  createCustomer(
    _ctx: ErpContext,
    payload: ErpCustomerPayload,
  ): Promise<{ externalCode: string }> {
    // Stable across restarts: derived from the customerCode, not a counter.
    const externalCode = bpOf(payload.customerCode);
    this.partners.set(externalCode, payload);
    this.logger.log(
      `mock SAP create BP ${payload.customerCode} → ${externalCode}`,
    );
    return Promise.resolve({ externalCode });
  }

  updateCustomer(
    _ctx: ErpContext,
    externalCode: string,
    payload: ErpCustomerPayload,
  ): Promise<void> {
    this.partners.set(externalCode, payload);
    this.logger.log(
      `mock SAP update BP ${externalCode} (${payload.customerCode})`,
    );
    return Promise.resolve();
  }

  getReceivables(
    _ctx: ErpContext,
    externalCode: string,
  ): Promise<ErpReceivables> {
    const { invoiceCount, outstanding } = mockOpenInvoices(externalCode);
    return Promise.resolve({
      outstanding,
      invoiceCount,
      asOf: new Date().toISOString(),
    });
  }

  findSalesOrder(
    _ctx: ErpContext,
    saleOrderCode: string,
  ): Promise<{ externalCode: string } | null> {
    const externalCode = orderNoOf(saleOrderCode);
    return Promise.resolve(
      this.orders.has(externalCode) ? { externalCode } : null,
    );
  }

  createSalesOrder(
    _ctx: ErpContext,
    payload: ErpSalesOrderPayload,
  ): Promise<{ externalCode: string }> {
    const externalCode = orderNoOf(payload.saleOrderCode);
    this.orders.set(externalCode, { payload, cancelled: false });
    this.logger.log(
      `mock SAP create SO ${payload.saleOrderCode} → ${externalCode} (BP ${payload.customerExternalCode}, ${payload.lines.length} lines)`,
    );
    return Promise.resolve({ externalCode });
  }

  listItems(_ctx: ErpContext): Promise<ErpItem[]> {
    return Promise.resolve([...MOCK_ITEMS]);
  }

  listVendors(_ctx: ErpContext): Promise<ErpVendor[]> {
    return Promise.resolve([...MOCK_VENDORS]);
  }

  /**
   * CD-89 — deterministic per customer and consistent with `getReceivables`:
   * the open invoices add up to its `outstanding`, plus two paid ones.
   */
  listInvoices(
    _ctx: ErpContext,
    externalCode: string,
    limit: number,
  ): Promise<ErpInvoice[]> {
    const { invoiceCount: openCount, outstanding } =
      mockOpenInvoices(externalCode);
    const today = Date.now();
    const day = (offset: number) =>
      new Date(today + offset * 86_400_000).toISOString().slice(0, 10);

    const open: ErpInvoice[] = Array.from({ length: openCount }, (_, i) => {
      const amount =
        i === openCount - 1
          ? outstanding - Math.floor(outstanding / openCount) * (openCount - 1)
          : Math.floor(outstanding / openCount);
      return {
        docNo: String(9000 + i),
        reference: null,
        issuedOn: day(-15 * (i + 1)),
        dueOn: day(30 - 15 * (i + 1)),
        currency: 'THB',
        total: amount,
        paid: 0,
        outstanding: amount,
        status: 'open',
      };
    });
    const paid: ErpInvoice[] = [1, 2].map((n) => ({
      docNo: String(8000 + n),
      reference: null,
      issuedOn: day(-90 * n),
      dueOn: day(-60 * n),
      currency: 'THB',
      total: 20000 * n,
      paid: 20000 * n,
      outstanding: 0,
      status: 'paid',
    }));
    return Promise.resolve([...open, ...paid].slice(0, limit));
  }

  cancelSalesOrder(
    _ctx: ErpContext,
    target: { externalCode: string; saleOrderCode: string },
    reason: string,
  ): Promise<void> {
    const order = this.orders.get(target.externalCode);
    if (order) order.cancelled = true;
    this.logger.log(`mock SAP cancel SO ${target.externalCode}: ${reason}`);
    return Promise.resolve();
  }
}

/**
 * A small, fixed catalog — enough to pick from on a quotation in any
 * environment. Real codes come from B1 once ERP_MODE=sapb1.
 */
/** CD-142 — sample suppliers, clearly not real ones, until CD-28 connects B1. */
const MOCK_VENDORS: readonly ErpVendor[] = [
  {
    code: 'MOCK-V0001',
    name: 'ตัวอย่าง ผู้จัดจำหน่ายอุปกรณ์เครือข่าย จำกัด',
    taxId: '0105500000001',
    phone: '02-000-0001',
    email: 'sales@vendor1.example',
    currency: 'THB',
    paymentTerms: '30 วัน',
    active: true,
  },
  {
    code: 'MOCK-V0002',
    name: 'ตัวอย่าง ผู้รับเหมางานเดินสาย จำกัด',
    taxId: '0105500000002',
    phone: '02-000-0002',
    email: null,
    currency: 'THB',
    paymentTerms: '45 วัน',
    active: true,
  },
  {
    code: 'MOCK-V0003',
    name: 'ตัวอย่าง ผู้จัดจำหน่ายซอฟต์แวร์ จำกัด',
    taxId: '0105500000003',
    phone: null,
    email: 'quote@vendor3.example',
    currency: 'USD',
    paymentTerms: null,
    active: true,
  },
  {
    code: 'MOCK-V0009',
    name: 'ตัวอย่าง ผู้ขายที่ถูกระงับ จำกัด',
    taxId: null,
    phone: null,
    email: null,
    currency: 'THB',
    paymentTerms: null,
    active: false,
  },
];

const VOICE = { groupCode: '101', groupName: 'บริการเสียง' };
const DEVICE = { groupCode: '102', groupName: 'อุปกรณ์' };
const SERVICE = { groupCode: '103', groupName: 'งานบริการ' };
const MOCK_ITEMS: readonly ErpItem[] = [
  {
    code: 'SIP-TRUNK',
    name: 'SIP Trunk (ต่อช่องสัญญาณ)',
    unit: 'ช่อง',
    active: true,
    ...VOICE,
  },
  {
    code: 'D-CALLCENTER',
    name: 'D-Callcenter License',
    unit: 'License',
    active: true,
    ...VOICE,
  },
  {
    code: 'IP-PHONE',
    name: 'IP Phone',
    unit: 'เครื่อง',
    active: true,
    ...DEVICE,
  },
  { code: 'HEADSET', name: 'Headset', unit: 'อัน', active: true, ...DEVICE },
  { code: 'SERVER', name: 'Server', unit: 'เครื่อง', active: true, ...DEVICE },
  {
    code: 'INSTALL',
    name: 'ค่าติดตั้ง',
    unit: 'งาน',
    active: true,
    ...SERVICE,
  },
  { code: 'MA-YEARLY', name: 'MA รายปี', unit: 'ปี', active: true, ...SERVICE },
  {
    code: 'OLD-PBX',
    name: 'PBX รุ่นเก่า (เลิกขาย)',
    unit: 'เครื่อง',
    active: false,
    ...DEVICE,
  },
];

function bpOf(customerCode: string): string {
  return `MOCK-${String(seedOf(customerCode)).padStart(10, '0')}`;
}

function orderNoOf(saleOrderCode: string): string {
  return `MOCK-SO-${String(seedOf(saleOrderCode)).padStart(10, '0')}`;
}

/**
 * The mock's open A/R for one BP — one source for both `getReceivables` and
 * `listInvoices`, so the 360° card and the invoice tab never disagree. No
 * open invoice means nothing outstanding (the old formula could say 12,500
 * across zero invoices).
 */
function mockOpenInvoices(externalCode: string): {
  invoiceCount: number;
  outstanding: number;
} {
  const seed = seedOf(externalCode);
  const invoiceCount = seed % 5;
  return {
    invoiceCount,
    outstanding: invoiceCount ? ((seed % 8) + 1) * 12500 : 0,
  };
}

function seedOf(text: string): number {
  let hash = 7;
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) % 1_000_003;
  return hash;
}
