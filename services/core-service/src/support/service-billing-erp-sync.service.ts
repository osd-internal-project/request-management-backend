import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { AuditWriter } from '@request-management/share';
import { backgroundTick } from '../common/background-tick';
import { CustomerExternalCodeRepository } from '../crm/customer-child.repositories';
import { CustomerRepository } from '../crm/customer.repository';
import { CompanyRepository } from '../crm/product.repositories';
import { CustomerErpSyncService } from '../crm/customer-erp-sync.service';
import { ErpSyncAdminService } from '../crm/erp-sync-admin.service';
import {
  enqueueErpJob,
  errorMessage,
  sweepErpJobs,
  type ErpJobRow,
} from '../crm/erp-sync-queue';
import { IntegrationSyncJobRepository } from '../crm/integration-job.repository';
import { thaiToday } from '../crm/vendor-costs';
import { ERP_CLIENT, ERP_SYSTEM } from '../erp/erp-client';
import type { ErpClient, ErpInvoiceDraftPayload } from '../erp/erp-client';
import { ServiceBillingRepository } from './support.repositories';

const KINDS = ['service_billing_create', 'service_billing_cancel'] as const;
type BillingJobKind = (typeof KINDS)[number];
/** How long a `pending` row may sit before `reconcile` queues it itself. */
const RECONCILE_AFTER_MS = 5 * 60_000;
/** How often a sent draft is looked up again for finance's posting and payment. */
const REFRESH_AFTER_MS = 60 * 60_000;
/** Read back until it is settled: paid, or cancelled in SAP. */
const STILL_MOVING = ['draft', 'open', 'missing'];

interface BillingForSync {
  id: string;
  companyId: string;
  reference: string;
  status: string;
  currency: string;
  netTotal: Prisma.Decimal;
  note: string | null;
  customerId: string;
  erpDraftNo: string | null;
  confirmedAt: Date | null;
  lines: {
    lineNo: number;
    productCode: string | null;
    description: string;
    quantity: Prisma.Decimal;
    unit: string | null;
    unitPrice: Prisma.Decimal;
    discountPct: Prisma.Decimal;
    lineTotal: Prisma.Decimal;
  }[];
}

/**
 * CD-242 — a billed service job to SAP B1 as a **draft A/R invoice**, the
 * store-and-forward way the sale orders go (CD-88): saved here first, sent
 * after the confirm commits, queued and retried when SAP is down or the
 * customer has no BP yet; the reference is looked up before creating, so a
 * retry adopts what an earlier attempt made. Cancelling deletes the draft
 * while finance has not posted it. Once sent, the draft is read back every
 * hour — posted (its invoice number), paid, or deleted in SAP.
 *
 * Its jobs show on the SAP queue admin page through
 * {@link ErpSyncAdminService.register}.
 */
@Injectable()
export class ServiceBillingErpSyncService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(ServiceBillingErpSyncService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly billings: ServiceBillingRepository,
    private readonly externalCodes: CustomerExternalCodeRepository,
    private readonly customers: CustomerRepository,
    private readonly companies: CompanyRepository,
    private readonly jobs: IntegrationSyncJobRepository,
    @Inject(ERP_CLIENT) private readonly erp: ErpClient,
    private readonly customerSync: CustomerErpSyncService,
    private readonly admin: ErpSyncAdminService,
    private readonly audit: AuditWriter,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    this.admin.register({
      kinds: KINDS,
      label: (ids, companyId) => this.labels(ids, companyId),
      reset: async (resourceId, prisma) => {
        await prisma.serviceBilling.update({
          where: { id: resourceId },
          data: { erpStatus: 'pending' },
        });
      },
      sweep: () => this.processQueue(),
    });
    const retryMs = this.config.get<number>('erp.retryIntervalMs') ?? 300_000;
    // `0` disables — tests and external-service.
    if (retryMs > 0) {
      this.timer = setInterval(
        backgroundTick(this.logger, 'SAP service-billing sweep', () =>
          this.processQueue(),
        ),
        retryMs,
      );
      this.timer.unref?.();
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** After the confirm commits. Never throws into the user's request. */
  kickCreate(billingId: string): void {
    this.kick('service_billing_create', billingId, () =>
      this.pushBilling(billingId),
    );
  }

  /** After the cancel commits. Never throws into the user's request. */
  kickCancel(billingId: string): void {
    this.kick('service_billing_cancel', billingId, () =>
      this.cancelBilling(billingId),
    );
  }

  /** One charge → a draft in SAP. Returns the draft's key, or null if not sent. */
  async pushBilling(billingId: string): Promise<string | null> {
    const billing = await this.load(billingId);
    if (billing.erpDraftNo) return billing.erpDraftNo;
    if (billing.status === 'cancelled') {
      await this.mark(billingId, { erpStatus: 'skipped', erpLastError: null });
      return null;
    }
    if (billing.status !== 'confirmed') return null;

    const customer = (await this.customers.findFirst({
      where: { id: billing.customerId },
      select: { customerCode: true, approvalStatus: true },
    })) as { customerCode: string; approvalStatus: string } | null;
    if (!customer) throw new Error(`customer ${billing.customerId} not found`);
    if (customer.approvalStatus !== 'approved') {
      await this.mark(billingId, {
        erpStatus: 'not_ready',
        erpLastError: `รออนุมัติเปิดลูกค้า ${customer.customerCode} ก่อนส่งเข้า SAP`,
      });
      return null;
    }
    const bp = (await this.externalCodes.findFirst({
      where: { customerId: billing.customerId, system: ERP_SYSTEM },
      select: { externalCode: true },
    })) as { externalCode: string } | null;
    if (!bp) {
      await this.customerSync.queueCustomer(
        billing.customerId,
        `ใบเรียกเก็บ ${billing.reference} รอเลข BP`,
      );
      throw new Error(
        `รอลูกค้า ${customer.customerCode} ได้เลข BP จาก SAP ก่อน`,
      );
    }

    const ctx = { companyCode: await this.companyCode(billing.companyId) };
    const found = await this.erp.findInvoiceDraft(ctx, billing.reference);
    const { externalCode } =
      found ?? (await this.erp.createInvoiceDraft(ctx, toPayload(billing, bp)));
    await this.mark(billingId, {
      erpStatus: 'synced',
      erpDraftNo: externalCode,
      erpSyncedAt: new Date(),
      erpLastError: null,
      erpInvoiceStatus: 'draft',
      erpCheckedAt: new Date(),
    });
    await this.audit.record({
      eventType: 'integration.sap.service_billing_synced',
      companyId: billing.companyId,
      actorId: null,
      actorUsername: `sap-sync:${this.erp.mode}`,
      resourceType: 'service_billing',
      resourceId: billingId,
      after: {
        reference: billing.reference,
        erpDraftNo: externalCode,
        netTotal: Number(billing.netTotal),
        lines: billing.lines.length,
        adopted: Boolean(found),
      },
    });

    // Cancelled while the create was in flight: SAP must not keep the draft.
    const after = await this.load(billingId);
    if (after.status === 'cancelled') await this.cancelBilling(billingId);
    return externalCode;
  }

  /** Delete the draft that reached SAP; one that never did is just skipped. */
  async cancelBilling(billingId: string): Promise<void> {
    const billing = await this.load(billingId);
    if (!billing.erpDraftNo) {
      await this.mark(billingId, { erpStatus: 'skipped', erpLastError: null });
      return;
    }
    const ctx = { companyCode: await this.companyCode(billing.companyId) };
    await this.erp.cancelInvoiceDraft(ctx, billing.reference);
    await this.mark(billingId, {
      erpStatus: 'synced',
      erpSyncedAt: new Date(),
      erpLastError: null,
      erpInvoiceStatus: 'missing',
      erpCheckedAt: new Date(),
    });
    await this.audit.record({
      eventType: 'integration.sap.service_billing_cancelled',
      companyId: billing.companyId,
      actorId: null,
      actorUsername: `sap-sync:${this.erp.mode}`,
      resourceType: 'service_billing',
      resourceId: billingId,
      after: { reference: billing.reference, erpDraftNo: billing.erpDraftNo },
    });
  }

  /** Where the draft stands in SAP now: posted, paid, still a draft, deleted. */
  async refresh(billingId: string): Promise<void> {
    const billing = await this.load(billingId);
    if (!billing.erpDraftNo) return;
    const state = await this.erp.invoiceDraftState(
      { companyCode: await this.companyCode(billing.companyId) },
      billing.reference,
    );
    await this.mark(billingId, {
      erpInvoiceStatus: state.status,
      erpInvoiceNo: state.invoiceNo,
      erpInvoiceTotal: state.total,
      erpPaid: state.paid,
      erpCheckedAt: new Date(),
    });
  }

  /** The sweeper — this service's kinds, then the hourly read-back. */
  async processQueue(): Promise<void> {
    await this.reconcile();
    await sweepErpJobs(
      this.jobs,
      KINDS,
      async (job: ErpJobRow) => {
        if (job.kind === 'service_billing_create') {
          await this.pushBilling(job.resourceId);
        } else {
          await this.cancelBilling(job.resourceId);
        }
      },
      this.logger,
      (job, error, exhausted) =>
        this.mark(job.resourceId, {
          erpLastError: error,
          ...(exhausted ? { erpStatus: 'failed' } : {}),
        }),
    );
    const stale = (await this.billings.findMany({
      where: {
        status: 'confirmed',
        erpStatus: 'synced',
        erpInvoiceStatus: { in: STILL_MOVING },
        OR: [
          { erpCheckedAt: null },
          { erpCheckedAt: { lt: new Date(Date.now() - REFRESH_AFTER_MS) } },
        ],
      },
      select: { id: true },
      orderBy: { erpCheckedAt: 'asc' },
      take: 20,
    })) as { id: string }[];
    for (const row of stale) {
      await this.refresh(row.id).catch((error) =>
        this.logger.warn(
          `service billing ${row.id} not read back: ${errorMessage(error)}`,
        ),
      );
    }
  }

  /** A row still `pending` with no job queued (a lost kick) gets one. */
  async reconcile(): Promise<void> {
    const rows = (await this.billings.findMany({
      where: {
        erpStatus: 'pending',
        updatedAt: { lt: new Date(Date.now() - RECONCILE_AFTER_MS) },
      },
      select: { id: true, status: true, erpDraftNo: true },
      orderBy: { updatedAt: 'asc' },
      take: 50,
    })) as { id: string; status: string; erpDraftNo: string | null }[];
    for (const row of rows) {
      const kind: BillingJobKind =
        row.status === 'cancelled' && row.erpDraftNo
          ? 'service_billing_cancel'
          : 'service_billing_create';
      await enqueueErpJob(
        this.jobs,
        kind,
        row.id,
        'reconcile: pending ไม่มีงานในคิว',
      );
    }
  }

  private kick(
    kind: BillingJobKind,
    billingId: string,
    work: () => Promise<unknown>,
  ): void {
    void work().catch(async (error) => {
      const reason = errorMessage(error);
      this.logger.warn(`sap ${kind} deferred for ${billingId}: ${reason}`);
      await this.mark(billingId, {
        erpStatus: 'pending',
        erpLastError: reason,
      }).catch(() => undefined);
      await enqueueErpJob(this.jobs, kind, billingId, reason);
    });
  }

  private async labels(ids: string[], companyId: string) {
    const rows = (await this.billings.findMany({
      where: { id: { in: ids }, companyId },
      select: { id: true, reference: true, customerId: true },
    })) as { id: string; reference: string; customerId: string }[];
    const names = new Map(
      (
        (await this.customers.findMany({
          where: { id: { in: rows.map((row) => row.customerId) } },
          select: { id: true, nameTh: true },
        })) as { id: string; nameTh: string }[]
      ).map((row) => [row.id, row.nameTh]),
    );
    return new Map(
      rows.map((row) => [
        row.id,
        {
          type: 'service_billing' as const,
          id: row.id,
          code: row.reference,
          name: names.get(row.customerId) ?? '',
        },
      ]),
    );
  }

  private async companyCode(companyId: string) {
    const row = (await this.companies.findFirst({
      where: { id: companyId },
      select: { code: true },
    })) as { code: string } | null;
    if (!row) throw new Error(`company ${companyId} not found`);
    return row.code;
  }

  private async load(billingId: string): Promise<BillingForSync> {
    const row = (await this.billings.findFirst({
      where: { id: billingId },
      include: { lines: { orderBy: { lineNo: 'asc' } } },
    })) as unknown as BillingForSync | null;
    if (!row) throw new Error(`service billing ${billingId} not found`);
    return row;
  }

  private async mark(
    billingId: string,
    data: Prisma.ServiceBillingUpdateInput,
  ) {
    await this.billings.update({ where: { id: billingId }, data });
  }
}

function toPayload(
  billing: BillingForSync,
  bp: { externalCode: string },
): ErpInvoiceDraftPayload {
  const lines = billing.lines.map((line) => ({
    lineNo: line.lineNo,
    productCode: line.productCode,
    description: line.description,
    quantity: Number(line.quantity),
    unit: line.unit,
    unitPrice: Number(line.unitPrice),
    discountPct: Number(line.discountPct),
    lineTotal: Number(line.lineTotal),
  }));
  return {
    reference: billing.reference,
    customerExternalCode: bp.externalCode,
    currency: billing.currency,
    issuedOn: thaiToday(billing.confirmedAt ?? new Date()),
    comment: [`Connect the Dot งานบริการ ${billing.reference}`, billing.note]
      .filter(Boolean)
      .join(' · '),
    netTotal:
      Math.round(lines.reduce((sum, l) => sum + l.lineTotal, 0) * 100) / 100,
    lines,
  };
}
