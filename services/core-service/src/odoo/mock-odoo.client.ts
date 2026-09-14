import { Injectable, Logger } from '@nestjs/common';
import { OdooClient, OdooPartnerPayload, OdooReceivables } from './odoo-client';

/**
 * The stand-in driver (ODOO_MODE=mock, the default until the sandbox
 * arrives). Deterministic on purpose: the same customer always gets the same
 * partner id and the same receivable figures, so a UAT walkthrough is
 * repeatable and a screenshot can be reproduced.
 */
@Injectable()
export class MockOdooClient implements OdooClient {
  readonly mode = 'mock' as const;
  private readonly logger = new Logger(MockOdooClient.name);
  private readonly partners = new Map<string, OdooPartnerPayload>();

  createPartner(payload: OdooPartnerPayload): Promise<{ partnerId: string }> {
    // Stable across restarts: derived from the customerCode, not a counter.
    const partnerId = `MOCK-${seedOf(payload.customerCode) % 90000}`;
    this.partners.set(partnerId, payload);
    this.logger.log(
      `mock createPartner ${payload.customerCode} → ${partnerId}`,
    );
    return Promise.resolve({ partnerId });
  }

  updatePartner(partnerId: string, payload: OdooPartnerPayload): Promise<void> {
    this.partners.set(partnerId, payload);
    this.logger.log(
      `mock updatePartner ${partnerId} (${payload.customerCode})`,
    );
    return Promise.resolve();
  }

  getReceivables(partnerId: string): Promise<OdooReceivables> {
    const seed = seedOf(partnerId);
    return Promise.resolve({
      outstanding: (seed % 8) * 12500,
      invoiceCount: seed % 5,
      asOf: new Date().toISOString(),
    });
  }
}

function seedOf(text: string): number {
  let hash = 7;
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) % 1_000_003;
  return hash;
}
