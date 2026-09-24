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
import type { ErpClient, ErpSalesOrderPayload } from '../erp/erp-client';
import { CustomerExternalCodeRepository } from './customer-child.repositories';
import { CustomerErpSyncService } from './customer-erp-sync.service';
import { IntegrationSyncJobRepository } from './integration-job.repository';
import { SaleOrderRepository } from './sales.repositories';
import {
  enqueueErpJob,
  errorMessage,
  sweepErpJobs,
  type ErpJobRow,
} from './erp-sync-queue';
import { backgroundTick } from '../common/background-tick';

const KINDS = ['sale_order_create', 'sale_order_cancel'] as const;
type SaleOrderJobKind = (typeof KINDS)[number];
/** How long a `pending` row may sit before `reconcile` queues it itself. */
const RECONCILE_AFTER_MS = 5 * 60_000;

/**
 * CD-88 — ใบสั่งขายเข้า SAP แบบ store-and-forward, คู่กับ CM-06 ของลูกค้า:
 *
 *   - ใบสั่งขายถูกบันทึกที่ CTD ก่อนเสมอ; หลัง commit `kickCreate` ส่ง SAP ทันที
 *     ถ้าล้ม (SAP ล่ม, ลูกค้ายังไม่มีเลข BP) งานลงคิวและ sweeper ลองใหม่ —
 *     หน้าจอเปิดใบสั่งขายไม่เคยรอ SAP;
 *   - ลูกค้าต้องถึง SAP ก่อน: ไม่มีเลข BP = ขอคิวส่งลูกค้า แล้วใบนี้รอรอบถัดไป;
 *   - ก่อนสร้างค้นด้วยเลข SO ของเรา — retry หลัง timeout ได้ใบเดิม ไม่สร้างซ้ำ;
 *   - ยกเลิกใบที่ถึง SAP แล้ว = ยกเลิกใน SAP ด้วย; ยกเลิกก่อนถึง = ไม่ส่งเลย.
 *
 * สถานะอยู่บนแถวใบสั่งขาย (`erpStatus`/`erpOrderNo`/`erpLastError`) ให้หน้าจอเห็น
 * ส่วนคิวและ audit `integration.sap.sale_order_*` คือบันทึกทุกรอบ.
 */
@Injectable()
export class SaleOrderErpSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SaleOrderErpSyncService.name);
  private retryTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly saleOrders: SaleOrderRepository,
    private readonly externalCodes: CustomerExternalCodeRepository,
    private readonly jobs: IntegrationSyncJobRepository,
    @Inject(ERP_CLIENT) private readonly erp: ErpClient,
    private readonly customerSync: CustomerErpSyncService,
    private readonly audit: AuditWriter,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const retryMs = this.config.get<number>('erp.retryIntervalMs') ?? 300_000;
    // `0` disables — tests, one-off scripts and external-service boot quiet.
    if (retryMs > 0) {
      this.retryTimer = setInterval(
        backgroundTick(this.logger, 'SAP sale-order sweep', () =>
          this.processQueue(),
        ),
        retryMs,
      );
      this.retryTimer.unref?.();
    }
  }

  onModuleDestroy(): void {
    if (this.retryTimer) clearInterval(this.retryTimer);
  }

  /** After the open commits. Never throws into the user's request. */
  kickCreate(saleOrderId: string): void {
    this.kick('sale_order_create', saleOrderId, () =>
      this.pushOrder(saleOrderId),
    );
  }

  /** After the cancel commits. Never throws into the user's request. */
  kickCancel(saleOrderId: string): void {
    this.kick('sale_order_cancel', saleOrderId, () =>
      this.cancelOrder(saleOrderId),
    );
  }

  /** One sale order → SAP. Returns SAP's order number, or null if not sent. */
  async pushOrder(saleOrderId: string): Promise<string | null> {
    const order = await this.load(saleOrderId);

    if (order.erpOrderNo) return order.erpOrderNo;
    if (order.status === 'cancelled') {
      await this.mark(saleOrderId, {
        erpStatus: 'skipped',
        erpLastError: null,
      });
      return null;
    }
    if (!order.lines.length) {
      // Nothing SAP can accept — not an error to retry, a state to show.
      await this.mark(saleOrderId, { erpStatus: 'not_ready' });
      return null;
    }

    const bp = (await this.externalCodes.findFirst({
      where: { customerId: order.customerId, system: ERP_SYSTEM },
      select: { externalCode: true },
    })) as { externalCode: string } | null;

    if (!bp) {
      await this.customerSync.queueCustomer(
        order.customerId,
        `ใบสั่งขาย ${order.saleOrderCode} รอเลข BP`,
      );
      throw new Error(
        `รอลูกค้า ${order.customer.customerCode} ได้เลข BP จาก SAP ก่อน`,
      );
    }

    const ctx = { companyCode: order.company.code };
    const payload = toPayload(order, bp.externalCode);
    const found = await this.erp.findSalesOrder(ctx, order.saleOrderCode);
    const { externalCode } =
      found ?? (await this.erp.createSalesOrder(ctx, payload));

    await this.mark(saleOrderId, {
      erpStatus: 'synced',
      erpOrderNo: externalCode,
      erpSyncedAt: new Date(),
      erpLastError: null,
    });

    await this.audit.record({
      eventType: 'integration.sap.sale_order_synced',
      companyId: order.companyId,
      actorId: null,
      actorUsername: `sap-sync:${this.erp.mode}`,
      resourceType: 'sale_order',
      resourceId: saleOrderId,
      after: {
        erpOrderNo: externalCode,
        saleOrderCode: order.saleOrderCode,
        customerExternalCode: bp.externalCode,
        lines: order.lines.length,
        adopted: Boolean(found),
      },
    });

    // Cancelled while the create was in flight: SAP must not keep a live order.
    const after = await this.load(saleOrderId);
    if (after.status === 'cancelled') await this.cancelOrder(saleOrderId);

    return externalCode;
  }

  /** Cancel in SAP what reached it; an order that never did is just skipped. */
  async cancelOrder(saleOrderId: string): Promise<void> {
    const order = await this.load(saleOrderId);

    if (!order.erpOrderNo) {
      await this.mark(saleOrderId, {
        erpStatus: 'skipped',
        erpLastError: null,
      });
      return;
    }

    await this.erp.cancelSalesOrder(
      { companyCode: order.company.code },
      { externalCode: order.erpOrderNo, saleOrderCode: order.saleOrderCode },
      order.cancelReason ?? 'ยกเลิกใน Connect the Dot',
    );
    await this.mark(saleOrderId, {
      erpStatus: 'synced',
      erpSyncedAt: new Date(),
      erpLastError: null,
    });

    await this.audit.record({
      eventType: 'integration.sap.sale_order_cancelled',
      companyId: order.companyId,
      actorId: null,
      actorUsername: `sap-sync:${this.erp.mode}`,
      resourceType: 'sale_order',
      resourceId: saleOrderId,
      after: {
        erpOrderNo: order.erpOrderNo,
        saleOrderCode: order.saleOrderCode,
      },
    });
  }

  /** The sweeper — this service's kinds only. Public so tests drive it. */
  async processQueue(): Promise<void> {
    await this.reconcile();
    await sweepErpJobs(
      this.jobs,
      KINDS,
      async (job: ErpJobRow) => {
        if (job.kind === 'sale_order_create') {
          await this.pushOrder(job.resourceId);
        } else {
          await this.cancelOrder(job.resourceId);
        }
      },
      this.logger,
      (job, error, exhausted) =>
        this.mark(job.resourceId, {
          erpLastError: error,
          ...(exhausted ? { erpStatus: 'failed' as const } : {}),
        }),
    );
  }

  /**
   * The row is the truth, the queue is a means: a sale order still `pending`
   * after RECONCILE_AFTER_MS with no pending job gets one. Covers a process
   * that died between commit and kick, and a job row an older build consumed
   * without understanding it (a deploy where the migration ran first).
   * Recent rows are left alone — their kick may still be in flight.
   */
  async reconcile(): Promise<void> {
    const rows = (await this.saleOrders.findMany({
      where: {
        erpStatus: 'pending',
        updatedAt: { lt: new Date(Date.now() - RECONCILE_AFTER_MS) },
      },
      select: { id: true, status: true, erpOrderNo: true },
      orderBy: { updatedAt: 'asc' },
      take: 50,
    })) as { id: string; status: string; erpOrderNo: string | null }[];

    for (const row of rows) {
      const kind: SaleOrderJobKind =
        row.status === 'cancelled' && row.erpOrderNo
          ? 'sale_order_cancel'
          : 'sale_order_create';
      await enqueueErpJob(
        this.jobs,
        kind,
        row.id,
        'reconcile: pending ไม่มีงานในคิว',
      );
    }
  }

  private kick(
    kind: SaleOrderJobKind,
    saleOrderId: string,
    work: () => Promise<unknown>,
  ): void {
    void work().catch(async (error) => {
      const reason = errorMessage(error);
      this.logger.warn(`sap ${kind} deferred for ${saleOrderId}: ${reason}`);
      await this.mark(saleOrderId, {
        erpStatus: 'pending',
        erpLastError: reason,
      }).catch(() => undefined);
      await enqueueErpJob(this.jobs, kind, saleOrderId, reason);
    });
  }

  private async load(saleOrderId: string): Promise<SaleOrderForSync> {
    const order = (await this.saleOrders.findFirst({
      where: { id: saleOrderId },
      select: {
        id: true,
        companyId: true,
        saleOrderCode: true,
        status: true,
        currency: true,
        orderedAt: true,
        cancelReason: true,
        customerId: true,
        erpOrderNo: true,
        customer: { select: { customerCode: true } },
        company: { select: { code: true } },
        lines: { orderBy: { lineNo: 'asc' } },
      },
    })) as SaleOrderForSync | null;

    if (!order) throw new Error(`sale order ${saleOrderId} not found`);
    return order;
  }

  private async mark(
    saleOrderId: string,
    data: Prisma.SaleOrderUpdateInput,
  ): Promise<void> {
    await this.saleOrders.update({ where: { id: saleOrderId }, data });
  }
}

interface SaleOrderLineRow {
  lineNo: number;
  productCode: string | null;
  description: string;
  quantity: Prisma.Decimal | number;
  unit: string | null;
  unitPrice: Prisma.Decimal | number;
  discountPct: Prisma.Decimal | number;
  lineTotal: Prisma.Decimal | number;
}

interface SaleOrderForSync {
  id: string;
  companyId: string;
  saleOrderCode: string;
  status: string;
  currency: string;
  orderedAt: Date;
  cancelReason: string | null;
  customerId: string;
  erpOrderNo: string | null;
  customer: { customerCode: string };
  company: { code: string };
  lines: SaleOrderLineRow[];
}

function toPayload(
  order: SaleOrderForSync,
  customerExternalCode: string,
): ErpSalesOrderPayload {
  const lines = order.lines.map((line) => ({
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
    saleOrderCode: order.saleOrderCode,
    customerExternalCode,
    currency: order.currency,
    orderedAt: order.orderedAt.toISOString(),
    // SAP gets what the lines add up to — the lines are the order.
    netTotal:
      Math.round(lines.reduce((sum, l) => sum + l.lineTotal, 0) * 100) / 100,
    lines,
  };
}
