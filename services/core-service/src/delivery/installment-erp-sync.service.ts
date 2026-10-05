import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { AuditWriter, PrismaService } from '@request-management/share';
import { backgroundTick } from '../common/background-tick';
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

const KINDS = [
  'installment_invoice_create',
  'installment_invoice_cancel',
] as const;
type JobKind = (typeof KINDS)[number];
const RECONCILE_AFTER_MS = 5 * 60_000;
const REFRESH_AFTER_MS = 60 * 60_000;
const STILL_MOVING = ['draft', 'open', 'missing'];

const KIND_TH: Record<string, string> = {
  deposit: 'เงินมัดจำ',
  progress: 'งวดตามความคืบหน้า',
  final: 'งวดสุดท้าย',
  retention: 'คืนเงินประกันผลงาน',
};

interface InvoiceForSync {
  id: string;
  companyId: string;
  contractId: string;
  seq: number;
  kind: string;
  label: string;
  reference: string;
  status: string;
  currency: string;
  amount: Prisma.Decimal;
  note: string | null;
  customerId: string;
  confirmedAt: Date | null;
  erpDraftNo: string | null;
}

/**
 * CD-253 — a sent installment to SAP B1 as a draft A/R invoice, the way
 * CD-242 sends a service charge: queued and retried when SAP is down or the
 * customer has no BP yet; looked up by reference (`INS-…`) before creating,
 * so a retry adopts what it made; deleted while finance has not posted it;
 * read back hourly — and what finance posted and was paid is written into
 * the installment tracking (CD-193, `source` = sap).
 */
@Injectable()
export class InstallmentErpSyncService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(InstallmentErpSyncService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
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
        await prisma.installmentInvoice.update({
          where: { id: resourceId },
          data: { erpStatus: 'pending' },
        });
      },
      sweep: () => this.processQueue(),
    });
    const retryMs = this.config.get<number>('erp.retryIntervalMs') ?? 300_000;
    if (retryMs > 0) {
      this.timer = setInterval(
        backgroundTick(this.logger, 'SAP installment-invoice sweep', () =>
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

  kickCreate(id: string): void {
    this.kick('installment_invoice_create', id, () => this.push(id));
  }

  kickCancel(id: string): void {
    this.kick('installment_invoice_cancel', id, () => this.cancel(id));
  }

  async push(id: string): Promise<string | null> {
    const row = await this.load(id);
    if (row.erpDraftNo) return row.erpDraftNo;
    if (row.status === 'cancelled') {
      await this.mark(id, { erpStatus: 'skipped', erpLastError: null });
      return null;
    }
    if (row.status !== 'sent') return null;
    const customer = await this.prisma.customer.findUnique({
      where: { id: row.customerId },
      select: { customerCode: true, approvalStatus: true },
    });
    if (!customer) throw new Error(`customer ${row.customerId} not found`);
    if (customer.approvalStatus !== 'approved') {
      await this.mark(id, {
        erpStatus: 'not_ready',
        erpLastError: `รออนุมัติเปิดลูกค้า ${customer.customerCode} ก่อนส่งเข้า SAP`,
      });
      return null;
    }
    const bp = await this.prisma.customerExternalCode.findFirst({
      where: { customerId: row.customerId, system: ERP_SYSTEM },
      select: { externalCode: true },
    });
    if (!bp) {
      await this.customerSync.queueCustomer(
        row.customerId,
        `วางบิลงวด ${row.reference} รอเลข BP`,
      );
      throw new Error(
        `รอลูกค้า ${customer.customerCode} ได้เลข BP จาก SAP ก่อน`,
      );
    }
    const ctx = { companyCode: await this.companyCode(row.companyId) };
    const found = await this.erp.findInvoiceDraft(ctx, row.reference);
    const { externalCode } =
      found ??
      (await this.erp.createInvoiceDraft(ctx, toPayload(row, bp.externalCode)));
    await this.mark(id, {
      erpStatus: 'synced',
      erpDraftNo: externalCode,
      erpSyncedAt: new Date(),
      erpLastError: null,
      erpInvoiceStatus: 'draft',
      erpCheckedAt: new Date(),
    });
    await this.audit.record({
      eventType: 'integration.sap.installment_invoice_synced',
      companyId: row.companyId,
      actorId: null,
      actorUsername: `sap-sync:${this.erp.mode}`,
      resourceType: 'installment_invoice',
      resourceId: id,
      after: {
        reference: row.reference,
        erpDraftNo: externalCode,
        amount: Number(row.amount),
        adopted: Boolean(found),
      },
    });
    // withdrawn while the create was in flight: SAP must not keep it
    if ((await this.load(id)).status === 'cancelled') await this.cancel(id);
    return externalCode;
  }

  async cancel(id: string): Promise<void> {
    const row = await this.load(id);
    if (!row.erpDraftNo) {
      await this.mark(id, { erpStatus: 'skipped', erpLastError: null });
      return;
    }
    const ctx = { companyCode: await this.companyCode(row.companyId) };
    await this.erp.cancelInvoiceDraft(ctx, row.reference);
    await this.mark(id, {
      erpStatus: 'synced',
      erpDraftNo: null,
      erpSyncedAt: new Date(),
      erpLastError: null,
      erpInvoiceStatus: 'missing',
      erpCheckedAt: new Date(),
    });
    await this.audit.record({
      eventType: 'integration.sap.installment_invoice_cancelled',
      companyId: row.companyId,
      actorId: null,
      actorUsername: `sap-sync:${this.erp.mode}`,
      resourceType: 'installment_invoice',
      resourceId: id,
      after: { reference: row.reference },
    });
  }

  /** Where it stands in SAP — and what finance posted/was paid into CD-193. */
  async refresh(id: string): Promise<void> {
    const row = await this.load(id);
    if (!row.erpDraftNo) return;
    const state = await this.erp.invoiceDraftState(
      { companyCode: await this.companyCode(row.companyId) },
      row.reference,
    );
    await this.mark(id, {
      erpInvoiceStatus: state.status,
      erpInvoiceNo: state.invoiceNo,
      erpInvoiceTotal: state.total,
      erpPaid: state.paid,
      erpCheckedAt: new Date(),
    });
    if (state.status === 'open' || state.status === 'paid') {
      const today = new Date(`${thaiToday()}T00:00:00Z`);
      const existing = await this.prisma.contractInstallmentBilling.findUnique({
        where: { contractId_seq: { contractId: row.contractId, seq: row.seq } },
        select: { source: true, invoicedOn: true, paidOn: true },
      });
      // a record made by hand is the manager's; only SAP's own is kept up to date
      if (existing && existing.source !== 'sap') return;
      const data = {
        invoiceNo: state.invoiceNo,
        invoicedOn: existing?.invoicedOn ?? today,
        invoicedAmount: state.total,
        paidAmount: state.paid,
        paidOn: state.status === 'paid' ? (existing?.paidOn ?? today) : null,
        source: 'sap',
      };
      await this.prisma.contractInstallmentBilling.upsert({
        where: { contractId_seq: { contractId: row.contractId, seq: row.seq } },
        create: {
          companyId: row.companyId,
          contractId: row.contractId,
          seq: row.seq,
          recordedBy: 'sap-sync',
          ...data,
        },
        update: data,
      });
    }
  }

  async processQueue(): Promise<void> {
    await this.reconcile();
    await sweepErpJobs(
      this.jobs,
      KINDS,
      async (job: ErpJobRow) => {
        if (job.kind === 'installment_invoice_create')
          await this.push(job.resourceId);
        else await this.cancel(job.resourceId);
      },
      this.logger,
      (job, error, exhausted) =>
        this.mark(job.resourceId, {
          erpLastError: error,
          ...(exhausted ? { erpStatus: 'failed' } : {}),
        }),
    );
    const stale = await this.prisma.installmentInvoice.findMany({
      where: {
        status: 'sent',
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
    });
    for (const row of stale) {
      await this.refresh(row.id).catch((error) =>
        this.logger.warn(
          `installment invoice ${row.id} not read back: ${errorMessage(error)}`,
        ),
      );
    }
  }

  async reconcile(): Promise<void> {
    const rows = await this.prisma.installmentInvoice.findMany({
      where: {
        erpStatus: 'pending',
        updatedAt: { lt: new Date(Date.now() - RECONCILE_AFTER_MS) },
      },
      select: { id: true, status: true, erpDraftNo: true },
      orderBy: { updatedAt: 'asc' },
      take: 50,
    });
    for (const row of rows) {
      const kind: JobKind =
        row.status === 'cancelled' && row.erpDraftNo
          ? 'installment_invoice_cancel'
          : 'installment_invoice_create';
      await enqueueErpJob(
        this.jobs,
        kind,
        row.id,
        'reconcile: pending ไม่มีงานในคิว',
      );
    }
  }

  private kick(kind: JobKind, id: string, work: () => Promise<unknown>): void {
    void work().catch(async (error) => {
      const reason = errorMessage(error);
      this.logger.warn(`sap ${kind} deferred for ${id}: ${reason}`);
      await this.mark(id, { erpStatus: 'pending', erpLastError: reason }).catch(
        () => undefined,
      );
      await enqueueErpJob(this.jobs, kind, id, reason);
    });
  }

  private async labels(ids: string[], companyId: string) {
    const rows = await this.prisma.installmentInvoice.findMany({
      where: { id: { in: ids }, companyId },
      select: { id: true, reference: true, label: true },
    });
    return new Map(
      rows.map((row) => [
        row.id,
        {
          type: 'installment_invoice' as const,
          id: row.id,
          code: row.reference,
          name: row.label,
        },
      ]),
    );
  }

  private async companyCode(companyId: string) {
    const row = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { code: true },
    });
    if (!row) throw new Error(`company ${companyId} not found`);
    return row.code;
  }

  private async load(id: string) {
    const row = (await this.prisma.installmentInvoice.findUnique({
      where: { id },
    })) as unknown as InvoiceForSync | null;
    if (!row) throw new Error(`installment invoice ${id} not found`);
    return row;
  }

  private async mark(id: string, data: Prisma.InstallmentInvoiceUpdateInput) {
    await this.prisma.installmentInvoice.update({ where: { id }, data });
  }
}

function toPayload(row: InvoiceForSync, bp: string): ErpInvoiceDraftPayload {
  const amount = Number(row.amount);
  return {
    reference: row.reference,
    customerExternalCode: bp,
    currency: row.currency,
    issuedOn: thaiToday(row.confirmedAt ?? new Date()),
    comment: [`Connect the Dot วางบิลงวด ${row.reference}`, row.note]
      .filter(Boolean)
      .join(' · '),
    netTotal: amount,
    lines: [
      {
        lineNo: 1,
        productCode: null,
        description: `${KIND_TH[row.kind] ?? row.kind} งวดที่ ${row.seq}: ${row.label}`,
        quantity: 1,
        unit: null,
        unitPrice: amount,
        discountPct: 0,
        lineTotal: amount,
      },
    ],
  };
}
