import { Injectable, Logger } from '@nestjs/common';
import {
  ErpClient,
  ErpContext,
  ErpCustomerPayload,
  ErpItem,
  ErpReceivables,
  ErpSalesOrderPayload,
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
    const seed = seedOf(externalCode);
    return Promise.resolve({
      outstanding: (seed % 8) * 12500,
      invoiceCount: seed % 5,
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
const MOCK_ITEMS: readonly ErpItem[] = [
  {
    code: 'SIP-TRUNK',
    name: 'SIP Trunk (ต่อช่องสัญญาณ)',
    unit: 'ช่อง',
    active: true,
  },
  {
    code: 'D-CALLCENTER',
    name: 'D-Callcenter License',
    unit: 'License',
    active: true,
  },
  { code: 'IP-PHONE', name: 'IP Phone', unit: 'เครื่อง', active: true },
  { code: 'HEADSET', name: 'Headset', unit: 'อัน', active: true },
  { code: 'SERVER', name: 'Server', unit: 'เครื่อง', active: true },
  { code: 'INSTALL', name: 'ค่าติดตั้ง', unit: 'งาน', active: true },
  { code: 'MA-YEARLY', name: 'MA รายปี', unit: 'ปี', active: true },
  {
    code: 'OLD-PBX',
    name: 'PBX รุ่นเก่า (เลิกขาย)',
    unit: 'เครื่อง',
    active: false,
  },
];

function bpOf(customerCode: string): string {
  return `MOCK-${String(seedOf(customerCode)).padStart(10, '0')}`;
}

function orderNoOf(saleOrderCode: string): string {
  return `MOCK-SO-${String(seedOf(saleOrderCode)).padStart(10, '0')}`;
}

function seedOf(text: string): number {
  let hash = 7;
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) % 1_000_003;
  return hash;
}
