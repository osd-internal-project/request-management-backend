import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import { AuditWriter } from '@request-management/share';
import { ERP_CLIENT, ERP_SYSTEM } from '../erp/erp-client';
import type { ErpClient, ErpCustomerPayload } from '../erp/erp-client';
import { CustomerRepository } from './customer.repository';
import { CustomerExternalCodeRepository } from './customer-child.repositories';
import { IntegrationSyncJobRepository } from './integration-job.repository';
import {
  enqueueErpJob,
  errorMessage as message,
  sweepErpJobs,
} from './erp-sync-queue';
import { backgroundTick } from '../common/background-tick';

const SYSTEM = ERP_SYSTEM;
/** The queue kinds this service owns — sale-order kinds belong to CD-88's. */
const KINDS = ['customer_upsert', 'receivables_refresh'] as const;

/**
 * CM-06 — customer sync through the integration layer, store-and-forward
 * (PO 8 ก.ย. 2569; ERP = SAP since 24 ก.ย. 2569):
 *
 *   - the customer is saved in Connect the Dot first; a create/update then
 *     **calls SAP** and stores the BP number it answers (`kickCustomer`,
 *     fired after the transaction commits — never inside it, so a slow SAP
 *     cannot hold a database transaction open);
 *   - when SAP is down the work lands in `integration_sync_jobs` and the
 *     sweeper retries with backoff — the customer screen never blocks;
 *   - a first push looks the customerCode up in SAP before creating, so a
 *     retry after a timeout adopts the BP the lost attempt made;
 *   - "ข้อมูลอื่น ๆ" run on the hourly pass: receivables for every synced
 *     customer, cached into the external-code row's `payload.receivables`,
 *     which is what the 360° page's การเงิน figures read (C360-02).
 *
 * Every sync outcome is audited (`integration.sap.*`) — the "ทุกรอบ sync มี
 * log" AC — and the queue rows themselves are kept after they finish.
 */
@Injectable()
export class CustomerErpSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CustomerErpSyncService.name);
  private retryTimer: NodeJS.Timeout | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly customers: CustomerRepository,
    private readonly externalCodes: CustomerExternalCodeRepository,
    private readonly jobs: IntegrationSyncJobRepository,
    @Inject(ERP_CLIENT) private readonly erp: ErpClient,
    private readonly audit: AuditWriter,
    private readonly config: ConfigService,
  ) {}

  /**
   * C360-02 — ยอดค้างชำระมาจาก SAP จริงหรือไม่. driver mock สร้างตัวเลขปลอม
   * (ใช้ทดสอบ sync ได้) แต่ห้ามโชว์บนการ์ดลูกค้าเหมือนเป็นยอดจริง.
   */
  get receivablesLive(): boolean {
    return this.erp.mode !== 'mock';
  }

  onModuleInit(): void {
    const retryMs = this.config.get<number>('erp.retryIntervalMs') ?? 300_000;
    const refreshMs =
      this.config.get<number>('erp.refreshIntervalMs') ?? 3_600_000;

    // `0` disables — tests and one-off scripts boot without timers underneath.
    if (retryMs > 0) {
      this.retryTimer = setInterval(
        backgroundTick(this.logger, 'SAP queue sweep', () =>
          this.processQueue(),
        ),
        retryMs,
      );
      this.retryTimer.unref?.();
    }
    if (refreshMs > 0) {
      this.refreshTimer = setInterval(
        backgroundTick(this.logger, 'SAP receivables refresh', () =>
          this.refreshAllReceivables(),
        ),
        refreshMs,
      );
      this.refreshTimer.unref?.();
    }
  }

  onModuleDestroy(): void {
    if (this.retryTimer) clearInterval(this.retryTimer);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
  }

  /**
   * Fire-and-forget entry point the customer write paths call AFTER their
   * transaction commits. Failure never propagates to the user's request —
   * it becomes a queue row instead.
   */
  kickCustomer(customerId: string): void {
    void this.syncCustomer(customerId).catch(async (error) => {
      this.logger.warn(
        `sap sync deferred for customer ${customerId}: ${message(error)}`,
      );
      await this.enqueue('customer_upsert', customerId, message(error));
    });
  }

  /** One customer → SAP. Returns the BP number it now has. */
  async syncCustomer(customerId: string): Promise<string> {
    const customer = (await this.customers.findFirst({
      where: { id: customerId, mergedIntoCustomerId: null },
      include: {
        company: { select: { code: true } },
        locations: {
          where: { active: true },
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
          take: 1,
        },
        contacts: {
          where: { active: true },
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
          take: 1,
        },
      },
    })) as CustomerForSync | null;

    if (!customer) {
      throw new Error(`customer ${customerId} not found or merged`);
    }

    const payload = toErpPayload(customer);
    const ctx = { companyCode: customer.company.code };

    const existing = (await this.externalCodes.findFirst({
      where: { customerId, system: SYSTEM },
    })) as ExternalCodeRow | null;

    let externalCode: string;
    if (existing) {
      externalCode = existing.externalCode;
      await this.erp.updateCustomer(ctx, externalCode, payload);
      await this.externalCodes.update({
        where: { id: existing.id },
        data: { payload: withPushed(existing.payload, payload) },
      });
    } else {
      // SAP does not dedupe for us: an earlier attempt may have created the
      // BP and then timed out before we stored its number.
      const found = await this.erp.findCustomer(ctx, payload.customerCode);
      if (found) {
        externalCode = found.externalCode;
        await this.erp.updateCustomer(ctx, externalCode, payload);
      } else {
        ({ externalCode } = await this.erp.createCustomer(ctx, payload));
      }
      await this.externalCodes.create({
        data: {
          customerId,
          system: SYSTEM,
          externalCode,
          payload: withPushed(null, payload),
        },
      });
    }

    // Best effort — การ์ดการเงินบนหน้า 360° ติดตัวเลขทันทีหลัง sync แรก
    // แทนที่จะรอรอบรายชั่วโมง; ล้มเหลวก็แค่รอรอบถัดไป.
    await this.refreshReceivables(customerId).catch(() => undefined);

    await this.audit.record({
      eventType: 'integration.sap.customer_synced',
      companyId: customer.companyId,
      actorId: null,
      actorUsername: `sap-sync:${this.erp.mode}`,
      resourceType: 'customer',
      resourceId: customerId,
      after: { externalCode, customerCode: customer.customerCode },
    });

    return externalCode;
  }

  /** C360-02 — cache ยอดค้างชำระ onto the external-code row. */
  async refreshReceivables(customerId: string): Promise<void> {
    const existing = (await this.externalCodes.findFirst({
      where: { customerId, system: SYSTEM },
      include: {
        customer: { select: { company: { select: { code: true } } } },
      },
    })) as
      (ExternalCodeRow & { customer: { company: { code: string } } }) | null;
    if (!existing) return;

    const receivables = await this.erp.getReceivables(
      { companyCode: existing.customer.company.code },
      existing.externalCode,
    );
    await this.externalCodes.update({
      where: { id: existing.id },
      data: {
        payload: {
          ...(asObject(existing.payload) ?? {}),
          receivables,
        } as unknown as Prisma.InputJsonValue,
      },
    });
  }

  /** The hourly pass — every synced customer's receivables, best effort. */
  async refreshAllReceivables(): Promise<void> {
    const rows = (await this.externalCodes.findMany({
      where: { system: SYSTEM },
      select: { customerId: true },
    })) as { customerId: string }[];

    for (const row of rows) {
      try {
        await this.refreshReceivables(row.customerId);
      } catch (error) {
        this.logger.warn(
          `receivables refresh failed for ${row.customerId}: ${message(error)}`,
        );
      }
    }
  }

  /** The sweeper — due queue rows, oldest first. Public so tests drive it. */
  async processQueue(): Promise<void> {
    await sweepErpJobs(
      this.jobs,
      KINDS,
      async (job) => {
        if (job.kind === 'customer_upsert') {
          await this.syncCustomer(job.resourceId);
        } else {
          await this.refreshReceivables(job.resourceId);
        }
      },
      this.logger,
    );
  }

  /**
   * Queue a customer push for the sweeper instead of calling SAP now — what a
   * sale order does when its customer has no BP yet (CD-88). Not an inline
   * call: the customer's own `kickCustomer` may be in flight, and two creates
   * racing past `findCustomer` would leave SAP with two BPs.
   */
  queueCustomer(customerId: string, reason: string): Promise<void> {
    return enqueueErpJob(this.jobs, 'customer_upsert', customerId, reason);
  }

  private enqueue(
    kind: (typeof KINDS)[number],
    resourceId: string,
    lastError: string,
  ): Promise<void> {
    return enqueueErpJob(this.jobs, kind, resourceId, lastError);
  }
}

interface CustomerForSync {
  id: string;
  companyId: string;
  company: { code: string };
  customerCode: string;
  nameTh: string;
  taxId: string | null;
  branchCode: string;
  branchName: string | null;
  status: string;
  locations: {
    line1: string;
    line2: string | null;
    district: string | null;
    province: string | null;
    postalCode: string | null;
  }[];
  contacts: { email: string | null; phone: string | null }[];
}

interface ExternalCodeRow {
  id: string;
  externalCode: string;
  payload: unknown;
}

function toErpPayload(customer: CustomerForSync): ErpCustomerPayload {
  const location = customer.locations[0];
  const contact = customer.contacts[0];
  return {
    customerCode: customer.customerCode,
    name: customer.nameTh,
    taxId: customer.taxId,
    branchCode: customer.branchCode,
    branchName: customer.branchName,
    email: contact?.email ?? null,
    phone: contact?.phone ?? null,
    street: location?.line1 ?? null,
    street2: location?.line2 ?? null,
    city: location?.province ?? null,
    zip: location?.postalCode ?? null,
    active: customer.status === 'active',
  };
}

function withPushed(
  previous: unknown,
  payload: ErpCustomerPayload,
): Prisma.InputJsonValue {
  return {
    ...(asObject(previous) ?? {}),
    lastPushedAt: new Date().toISOString(),
    lastPushed: { name: payload.name, active: payload.active },
  };
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
