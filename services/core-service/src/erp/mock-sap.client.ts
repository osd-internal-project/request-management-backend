import { Injectable, Logger } from '@nestjs/common';
import { ErpClient, ErpCustomerPayload, ErpReceivables } from './erp-client';

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

  findCustomer(customerCode: string): Promise<{ externalCode: string } | null> {
    const externalCode = bpOf(customerCode);
    return Promise.resolve(
      this.partners.has(externalCode) ? { externalCode } : null,
    );
  }

  createCustomer(
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
    externalCode: string,
    payload: ErpCustomerPayload,
  ): Promise<void> {
    this.partners.set(externalCode, payload);
    this.logger.log(
      `mock SAP update BP ${externalCode} (${payload.customerCode})`,
    );
    return Promise.resolve();
  }

  getReceivables(externalCode: string): Promise<ErpReceivables> {
    const seed = seedOf(externalCode);
    return Promise.resolve({
      outstanding: (seed % 8) * 12500,
      invoiceCount: seed % 5,
      asOf: new Date().toISOString(),
    });
  }
}

function bpOf(customerCode: string): string {
  return `MOCK-${String(seedOf(customerCode)).padStart(10, '0')}`;
}

function seedOf(text: string): number {
  let hash = 7;
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) % 1_000_003;
  return hash;
}
