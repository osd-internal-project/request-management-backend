import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ERP_CLIENT, ERP_SYSTEM } from '../erp/erp-client';
import type { ErpClient } from '../erp/erp-client';
import { CustomerExternalCodeRepository } from './customer-child.repositories';
import { SaleOrderRepository } from './sales.repositories';

/** Every number `MockSapClient` issues starts with this — BPs and orders. */
export const MOCK_CODE_PREFIX = 'MOCK-';

/** Where retired mock BP numbers are kept — out of the way, not deleted. */
export const MOCK_SYSTEM = `${ERP_SYSTEM}-mock`;

/**
 * Switching ERP_MODE from mock to a real driver leaves the mock's answers in
 * the database: `MOCK-…` BP numbers the real SAP never issued, cached fake
 * receivables, sale orders marked synced that SAP never saw. Left there, the
 * driver would PATCH a BP that does not exist, the 360° card would show fake
 * figures as real, and those orders would never reach SAP.
 *
 * So on every boot under a real driver, retire them — idempotent, a no-op
 * once done:
 *   - BP rows → `system = 'sap-mock'` (kept for history, invisible to sync);
 *     the customer is pushed for real on its next edit or sale order;
 *   - open orders "synced" to the mock → `pending`, number cleared, and
 *     `reconcile` queues them; cancelled ones → `skipped`.
 *
 * core-service only: ERP_RETRY_INTERVAL_MS=0 (external-service, tests) skips.
 */
@Injectable()
export class ErpMockRetirementService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ErpMockRetirementService.name);

  constructor(
    @Inject(ERP_CLIENT) private readonly erp: ErpClient,
    private readonly externalCodes: CustomerExternalCodeRepository,
    private readonly saleOrders: SaleOrderRepository,
    private readonly config: ConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.erp.mode === 'mock') return;
    if ((this.config.get<number>('erp.retryIntervalMs') ?? 300_000) <= 0)
      return;

    try {
      await this.retire();
    } catch (error) {
      // Never block the boot over housekeeping — the next boot tries again.
      this.logger.error(`retiring mock ERP data failed: ${String(error)}`);
    }
  }

  async retire(): Promise<void> {
    const codes = await this.externalCodes.updateMany({
      where: {
        system: ERP_SYSTEM,
        externalCode: { startsWith: MOCK_CODE_PREFIX },
      },
      data: { system: MOCK_SYSTEM },
    });

    const reopened = await this.saleOrders.updateMany({
      where: {
        status: 'open',
        erpOrderNo: { startsWith: MOCK_CODE_PREFIX },
      },
      data: {
        erpStatus: 'pending',
        erpOrderNo: null,
        erpSyncedAt: null,
        erpLastError: 'ออกเลขโดย mock — รอส่ง SAP จริง',
      },
    });

    const skipped = await this.saleOrders.updateMany({
      where: {
        status: 'cancelled',
        erpOrderNo: { startsWith: MOCK_CODE_PREFIX },
      },
      data: { erpStatus: 'skipped', erpOrderNo: null, erpSyncedAt: null },
    });

    if (codes.count || reopened.count || skipped.count) {
      this.logger.warn(
        `ERP_MODE=${this.erp.mode}: retired mock data — ${codes.count} BP code(s), ${reopened.count} open order(s) re-queued, ${skipped.count} cancelled order(s) skipped`,
      );
    }
  }
}
