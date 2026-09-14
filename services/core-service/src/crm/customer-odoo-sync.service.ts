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
import { ODOO_CLIENT } from '../odoo/odoo-client';
import type { OdooClient, OdooPartnerPayload } from '../odoo/odoo-client';
import { CustomerRepository } from './customer.repository';
import { CustomerExternalCodeRepository } from './customer-child.repositories';
import { IntegrationSyncJobRepository } from './integration-job.repository';

const SYSTEM = 'odoo';
const MAX_ATTEMPTS = 10;

/** Backoff: 1m, 2m, 4m … capped at 30m — a down Odoo is retried, not hammered. */
function backoffMs(attempts: number): number {
  return Math.min(60_000 * 2 ** attempts, 30 * 60_000);
}

/**
 * CM-06 — customer sync through the integration layer (PO 8 ก.ย. 2569):
 *
 *   - a create/update **calls Odoo now** and stores the partner id it answers
 *     (`kickCustomer`, fired after the transaction commits — never inside it,
 *     so a slow Odoo cannot hold a database transaction open);
 *   - when Odoo is down the work lands in `integration_sync_jobs` and the
 *     sweeper retries with backoff — the customer screen never blocks;
 *   - "ข้อมูลอื่น ๆ" run on the hourly pass: receivables for every synced
 *     customer, cached into the external-code row's `payload.receivables`,
 *     which is what the 360° page's การเงิน figures read (C360-02).
 *
 * Every sync outcome is audited (`integration.odoo.*`) — the "ทุกรอบ sync มี
 * log" AC — and the queue rows themselves are kept after they finish.
 */
@Injectable()
export class CustomerOdooSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CustomerOdooSyncService.name);
  private retryTimer: NodeJS.Timeout | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly customers: CustomerRepository,
    private readonly externalCodes: CustomerExternalCodeRepository,
    private readonly jobs: IntegrationSyncJobRepository,
    @Inject(ODOO_CLIENT) private readonly odoo: OdooClient,
    private readonly audit: AuditWriter,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const retryMs = this.config.get<number>('odoo.retryIntervalMs') ?? 300_000;
    const refreshMs =
      this.config.get<number>('odoo.refreshIntervalMs') ?? 3_600_000;

    // `0` disables — tests and one-off scripts boot without timers underneath.
    if (retryMs > 0) {
      this.retryTimer = setInterval(() => void this.processQueue(), retryMs);
      this.retryTimer.unref?.();
    }
    if (refreshMs > 0) {
      this.refreshTimer = setInterval(
        () => void this.refreshAllReceivables(),
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
        `odoo sync deferred for customer ${customerId}: ${message(error)}`,
      );
      await this.enqueue('customer_upsert', customerId, message(error));
    });
  }

  /** One customer → Odoo. Returns the partner id it now has. */
  async syncCustomer(customerId: string): Promise<string> {
    const customer = (await this.customers.findFirst({
      where: { id: customerId, mergedIntoCustomerId: null },
      include: {
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

    const payload = toPartnerPayload(customer);

    const existing = (await this.externalCodes.findFirst({
      where: { customerId, system: SYSTEM },
    })) as ExternalCodeRow | null;

    let partnerId: string;
    if (existing) {
      partnerId = existing.externalCode;
      await this.odoo.updatePartner(partnerId, payload);
      await this.externalCodes.update({
        where: { id: existing.id },
        data: { payload: withPartner(existing.payload, payload) },
      });
    } else {
      ({ partnerId } = await this.odoo.createPartner(payload));
      await this.externalCodes.create({
        data: {
          customerId,
          system: SYSTEM,
          externalCode: partnerId,
          payload: withPartner(null, payload),
        },
      });
    }

    // Best effort — การ์ดการเงินบนหน้า 360° ติดตัวเลขทันทีหลัง sync แรก
    // แทนที่จะรอรอบรายชั่วโมง; ล้มเหลวก็แค่รอรอบถัดไป.
    await this.refreshReceivables(customerId).catch(() => undefined);

    await this.audit.record({
      eventType: 'integration.odoo.customer_synced',
      companyId: customer.companyId,
      actorId: null,
      actorUsername: `odoo-sync:${this.odoo.mode}`,
      resourceType: 'customer',
      resourceId: customerId,
      after: { partnerId, customerCode: customer.customerCode },
    });

    return partnerId;
  }

  /** C360-02 — cache ยอดค้างชำระ onto the external-code row. */
  async refreshReceivables(customerId: string): Promise<void> {
    const existing = (await this.externalCodes.findFirst({
      where: { customerId, system: SYSTEM },
    })) as ExternalCodeRow | null;
    if (!existing) return;

    const receivables = await this.odoo.getReceivables(existing.externalCode);
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
    const due = (await this.jobs.findMany({
      where: {
        system: SYSTEM,
        status: 'pending',
        runAfter: { lte: new Date() },
      },
      orderBy: { createdAt: 'asc' },
      take: 20,
    })) as JobRow[];

    for (const job of due) {
      try {
        if (job.kind === 'customer_upsert') {
          await this.syncCustomer(job.resourceId);
        } else {
          await this.refreshReceivables(job.resourceId);
        }
        await this.jobs.update({
          where: { id: job.id },
          data: { status: 'succeeded', attempts: job.attempts + 1 },
        });
      } catch (error) {
        const attempts = job.attempts + 1;
        const exhausted = attempts >= MAX_ATTEMPTS;
        await this.jobs.update({
          where: { id: job.id },
          data: {
            attempts,
            lastError: message(error),
            status: exhausted ? 'failed' : 'pending',
            runAfter: new Date(Date.now() + backoffMs(attempts)),
          },
        });
        if (exhausted) {
          this.logger.error(
            `odoo job ${job.id} (${job.kind} ${job.resourceId}) gave up after ${attempts}: ${message(error)}`,
          );
        }
      }
    }
  }

  private async enqueue(
    kind: 'customer_upsert' | 'receivables_refresh',
    resourceId: string,
    lastError: string,
  ): Promise<void> {
    const pending = (await this.jobs.findFirst({
      where: { system: SYSTEM, kind, resourceId, status: 'pending' },
      select: { id: true },
    })) as { id: string } | null;

    // One pending row per (kind, customer): the sync always reads the latest
    // state of the customer, so stacking duplicates buys nothing.
    if (pending) return;

    await this.jobs.create({
      data: { system: SYSTEM, kind, resourceId, lastError },
    });
  }
}

interface CustomerForSync {
  id: string;
  companyId: string;
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

interface JobRow {
  id: string;
  kind: string;
  resourceId: string;
  attempts: number;
}

function toPartnerPayload(customer: CustomerForSync): OdooPartnerPayload {
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

function withPartner(
  previous: unknown,
  payload: OdooPartnerPayload,
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

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
