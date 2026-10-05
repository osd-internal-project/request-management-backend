import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  AppError,
  AuditWriter,
  auditActor,
  Principal,
  PrismaTransactionService,
} from '@request-management/share';
import { ERP_SYSTEM } from '../erp/erp-client';
import { CustomerRepository } from './customer.repository';
import { CustomerErpSyncService } from './customer-erp-sync.service';
import { IntegrationSyncJobRepository } from './integration-job.repository';
import { SaleOrderErpSyncService } from './sale-order-erp-sync.service';
import { SaleOrderRepository } from './sales.repositories';

const CUSTOMER_KINDS = ['customer_upsert', 'receivables_refresh'];
const SALE_ORDER_KINDS = ['sale_order_create', 'sale_order_cancel'];

/** Enough rows for an admin to act on; the queue is not meant to grow past it. */
const LIST_LIMIT = 500;

/**
 * How long a retry waits for its sweep before answering. Long enough for a
 * healthy SAP to answer, so the admin sees "sent" or the new error at once;
 * short enough that a hanging SAP never holds the click.
 */
const RETRY_WAIT_MS = 5_000;

export type ErpJobFilter = 'failed' | 'pending' | 'all';

/**
 * CD-242 — another module's kinds on the same queue (service billing): how
 * to label its rows for this company, mark one pending again on retry, and
 * run its sweeper. Registered from that module, so `crm/` never imports it.
 */
export interface ErpJobKindHandler {
  readonly kinds: readonly string[];
  label(
    ids: string[],
    companyId: string,
  ): Promise<Map<string, ErpJobItem['resource']>>;
  reset(resourceId: string, prisma: Prisma.TransactionClient): Promise<void>;
  sweep(): Promise<void>;
}

export interface ErpJobItem {
  id: string;
  kind: string;
  /** `succeeded` only ever comes back from `retry` — the list holds open work. */
  status: 'pending' | 'failed' | 'succeeded';
  attempts: number;
  lastError: string | null;
  runAfter: Date;
  createdAt: Date;
  updatedAt: Date;
  resource: {
    type:
      | 'customer'
      | 'sale_order'
      | 'service_billing'
      | 'service_material'
      | 'installment_invoice';
    id: string;
    /** รหัสที่คนอ่าน — รหัสลูกค้า หรือเลขใบสั่งขาย. */
    code: string;
    /** ชื่อลูกค้า (ของใบสั่งขายก็เป็นลูกค้าของใบ). */
    name: string;
  };
}

interface JobRow {
  id: string;
  kind: string;
  resourceId: string;
  status: 'pending' | 'failed';
  attempts: number;
  lastError: string | null;
  runAfter: Date;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * CM-06 / CD-88 — หน้าผู้ดูแลคิวส่ง SAP (`admin.integration.manage`).
 *
 * งานที่ส่งไม่สำเร็จครบรอบ (`failed`) หยุดลองเองแล้ว — ก่อนมีหน้านี้ทางเดียวคือ
 * แก้ฐานข้อมูลตรง. หน้านี้ให้ผู้ดูแลเห็นข้อผิดพลาดล่าสุดตามที่ SAP ตอบ แก้ต้นเหตุ
 * (ข้อมูลลูกค้า, ค่าตั้งใน B1) แล้วกดส่งใหม่.
 *
 * แถวคิวไม่มี companyId: ขอบเขตบริษัท (SCOPE-03) ตัดสินจากลูกค้า/ใบสั่งขาย
 * ที่แถวชี้ไป — ของบริษัทอื่นไม่ถูกแสดงและกดส่งใหม่ไม่ได้ (404).
 */
@Injectable()
export class ErpSyncAdminService {
  private readonly logger = new Logger(ErpSyncAdminService.name);
  private readonly handlers: ErpJobKindHandler[] = [];

  constructor(
    private readonly jobs: IntegrationSyncJobRepository,
    private readonly customers: CustomerRepository,
    private readonly saleOrders: SaleOrderRepository,
    private readonly customerSync: CustomerErpSyncService,
    private readonly saleOrderSync: SaleOrderErpSyncService,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  register(handler: ErpJobKindHandler): void {
    this.handlers.push(handler);
  }

  async list(actor: Principal, filter: ErpJobFilter = 'failed') {
    const rows = (await this.jobs.findMany({
      where: { system: ERP_SYSTEM, status: { in: ['pending', 'failed'] } },
      orderBy: { updatedAt: 'desc' },
      take: LIST_LIMIT,
    })) as JobRow[];

    const items = await this.withResources(rows, actor.activeCompanyId);

    return {
      summary: {
        failed: items.filter((item) => item.status === 'failed').length,
        pending: items.filter((item) => item.status === 'pending').length,
      },
      items:
        filter === 'all'
          ? items
          : items.filter((item) => item.status === filter),
    };
  }

  /**
   * เริ่มนับใหม่: attempts = 0, ถึงกำหนดทันที แล้วปลุก sweeper ของชนิดนั้น —
   * รอผลไม่เกิน RETRY_WAIT_MS แล้วตอบสถานะจริงของงาน (สำเร็จ / ยังไม่สำเร็จพร้อม
   * ข้อผิดพลาดใหม่ / ยังส่งอยู่) ให้ผู้ดูแลรู้ผลทันทีที่กด.
   */
  async retry(id: string, actor: Principal): Promise<ErpJobItem> {
    const row = (await this.jobs.findFirst({
      where: { id, system: ERP_SYSTEM },
    })) as (Omit<JobRow, 'status'> & { status: string }) | null;

    const [item] = row
      ? await this.withResources([row as JobRow], actor.activeCompanyId)
      : [];
    if (!row || !item) {
      throw new AppError('NOT_FOUND', 'ไม่พบงานในคิวส่ง SAP ที่ระบุ');
    }
    if (row.status === 'succeeded') {
      throw new AppError('CONFLICT', 'งานนี้ส่งสำเร็จแล้ว ไม่ต้องส่งใหม่');
    }

    const isSaleOrder = SALE_ORDER_KINDS.includes(row.kind);
    const handler = this.handlers.find((h) => h.kinds.includes(row.kind));

    await this.transactions.execute(async (prisma) => {
      await this.jobs.update(
        {
          where: { id },
          data: { status: 'pending', attempts: 0, runAfter: new Date() },
        },
        { prisma },
      );

      if (isSaleOrder) {
        await this.saleOrders.update(
          { where: { id: row.resourceId }, data: { erpStatus: 'pending' } },
          { prisma },
        );
      }
      if (handler) await handler.reset(row.resourceId, prisma);

      await this.audit.record(
        {
          eventType: 'integration.sap.job_retried',
          companyId: actor.activeCompanyId,
          ...auditActor(actor),
          resourceType: item.resource.type,
          resourceId: row.resourceId,
          before: {
            status: row.status,
            attempts: row.attempts,
            lastError: row.lastError,
          },
          after: { status: 'pending', attempts: 0, jobId: id, kind: row.kind },
        },
        { prisma },
      );
    });

    // After the commit, not inside it. Waited on only up to RETRY_WAIT_MS —
    // past that it carries on in the background and the list shows the end.
    const sweep = (
      handler
        ? handler.sweep()
        : isSaleOrder
          ? this.saleOrderSync.processQueue()
          : this.customerSync.processQueue()
    ).catch((error) =>
      this.logger.warn(`sweep after retry ${id} failed: ${String(error)}`),
    );
    await Promise.race([
      sweep,
      new Promise((resolve) => setTimeout(resolve, RETRY_WAIT_MS).unref?.()),
    ]);

    const after = (await this.jobs.findFirst({
      where: { id },
      select: {
        status: true,
        attempts: true,
        lastError: true,
        runAfter: true,
        updatedAt: true,
      },
    })) as Pick<
      ErpJobItem,
      'status' | 'attempts' | 'lastError' | 'runAfter' | 'updatedAt'
    > | null;

    return { ...item, ...(after ?? { status: 'pending', attempts: 0 }) };
  }

  /** Label each row by what it points at; rows of other companies drop out. */
  private async withResources(
    rows: JobRow[],
    companyId: string,
  ): Promise<ErpJobItem[]> {
    const customerIds = rows
      .filter((row) => CUSTOMER_KINDS.includes(row.kind))
      .map((row) => row.resourceId);
    const saleOrderIds = rows
      .filter((row) => SALE_ORDER_KINDS.includes(row.kind))
      .map((row) => row.resourceId);

    const [customers, saleOrders] = await Promise.all([
      customerIds.length
        ? (this.customers.findMany({
            where: { id: { in: customerIds }, companyId },
            select: { id: true, customerCode: true, nameTh: true },
          }) as Promise<{ id: string; customerCode: string; nameTh: string }[]>)
        : Promise.resolve([]),
      saleOrderIds.length
        ? (this.saleOrders.findMany({
            where: { id: { in: saleOrderIds }, companyId },
            select: {
              id: true,
              saleOrderCode: true,
              customer: { select: { nameTh: true } },
            },
          }) as unknown as Promise<
            {
              id: string;
              saleOrderCode: string;
              customer: { nameTh: string };
            }[]
          >)
        : Promise.resolve([]),
    ]);

    const customerById = new Map(customers.map((c) => [c.id, c]));
    const orderById = new Map(saleOrders.map((o) => [o.id, o]));
    const others = new Map<string, ErpJobItem['resource']>();
    for (const handler of this.handlers) {
      const ids = rows
        .filter((row) => handler.kinds.includes(row.kind))
        .map((row) => row.resourceId);
      if (!ids.length) continue;
      for (const [id, resource] of await handler.label(ids, companyId)) {
        others.set(id, resource);
      }
    }

    return rows.flatMap((row): ErpJobItem[] => {
      const base = {
        id: row.id,
        kind: row.kind,
        status: row.status,
        attempts: row.attempts,
        lastError: row.lastError,
        runAfter: row.runAfter,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
      const customer = customerById.get(row.resourceId);
      if (customer && CUSTOMER_KINDS.includes(row.kind)) {
        return [
          {
            ...base,
            resource: {
              type: 'customer',
              id: customer.id,
              code: customer.customerCode,
              name: customer.nameTh,
            },
          },
        ];
      }
      const order = orderById.get(row.resourceId);
      if (order && SALE_ORDER_KINDS.includes(row.kind)) {
        return [
          {
            ...base,
            resource: {
              type: 'sale_order',
              id: order.id,
              code: order.saleOrderCode,
              name: order.customer.nameTh,
            },
          },
        ];
      }
      const other = others.get(row.resourceId);
      if (
        other &&
        this.handlers.some((handler) => handler.kinds.includes(row.kind))
      ) {
        return [{ ...base, resource: other }];
      }
      return [];
    });
  }
}
