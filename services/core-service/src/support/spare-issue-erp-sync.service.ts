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
import { ErpSyncAdminService } from '../crm/erp-sync-admin.service';
import {
  enqueueErpJob,
  errorMessage,
  sweepErpJobs,
  type ErpJobRow,
} from '../crm/erp-sync-queue';
import { IntegrationSyncJobRepository } from '../crm/integration-job.repository';
import { CompanyRepository } from '../crm/product.repositories';
import { ERP_CLIENT } from '../erp/erp-client';
import type { ErpClient } from '../erp/erp-client';
import { issueReference } from './claim-rules';
import { ServiceMaterialUseRepository } from './support.repositories';

const KINDS = ['service_goods_issue'] as const;
const RECONCILE_AFTER_MS = 5 * 60_000;

interface IssueRow {
  id: string;
  companyId: string;
  requestId: string;
  productCode: string;
  description: string;
  quantity: Prisma.Decimal;
  serialNo: string | null;
  fromStock: boolean;
  warehouseCode: string | null;
  usedOn: Date;
  erpStatus: string;
  erpDocNo: string | null;
  deletedAt: Date | null;
}

/**
 * CD-245 — a spare taken out of stock for a service job becomes a goods
 * issue in SAP B1 (`InventoryGenExits`): the stock moves in the ERP, never
 * here. Store-and-forward like the sale orders (CD-88): sent after the save
 * commits, queued and retried, looked up by its reference before creating so
 * a retry adopts the first attempt. Its jobs show on the SAP queue page.
 */
@Injectable()
export class SpareIssueErpSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SpareIssueErpSyncService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly materials: ServiceMaterialUseRepository,
    private readonly companies: CompanyRepository,
    private readonly jobs: IntegrationSyncJobRepository,
    @Inject(ERP_CLIENT) private readonly erp: ErpClient,
    private readonly admin: ErpSyncAdminService,
    private readonly audit: AuditWriter,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    this.admin.register({
      kinds: KINDS,
      label: async (ids, companyId) => {
        const rows = (await this.materials.findMany({
          where: { id: { in: ids }, companyId },
          select: { id: true, productCode: true, description: true },
        })) as { id: string; productCode: string; description: string }[];
        return new Map(
          rows.map((row) => [
            row.id,
            {
              type: 'service_material' as const,
              id: row.id,
              code: issueReference(row.id),
              name: `${row.productCode} · ${row.description}`,
            },
          ]),
        );
      },
      reset: async (resourceId, prisma) => {
        await prisma.serviceMaterialUse.update({
          where: { id: resourceId },
          data: { erpStatus: 'pending' },
        });
      },
      sweep: () => this.processQueue(),
    });
    const retryMs = this.config.get<number>('erp.retryIntervalMs') ?? 300_000;
    if (retryMs > 0) {
      this.timer = setInterval(
        backgroundTick(this.logger, 'SAP goods-issue sweep', () =>
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

  /** After the save commits. Never throws into the user's request. */
  kick(materialId: string): void {
    void this.push(materialId).catch(async (error) => {
      const reason = errorMessage(error);
      this.logger.warn(`sap goods issue deferred for ${materialId}: ${reason}`);
      await this.mark(materialId, {
        erpStatus: 'pending',
        erpLastError: reason,
      }).catch(() => undefined);
      await enqueueErpJob(this.jobs, KINDS[0], materialId, reason);
    });
  }

  /** One spare → a goods issue. Returns SAP's number, or null if not sent. */
  async push(materialId: string): Promise<string | null> {
    const row = await this.load(materialId);
    if (row.erpDocNo) return row.erpDocNo;
    if (row.deletedAt || !row.fromStock) {
      await this.mark(materialId, { erpStatus: 'none', erpLastError: null });
      return null;
    }
    if (!row.warehouseCode) throw new Error('ไม่ได้ระบุคลังที่เบิก');
    const company = (await this.companies.findFirst({
      where: { id: row.companyId },
      select: { code: true },
    })) as { code: string } | null;
    if (!company) throw new Error(`company ${row.companyId} not found`);
    const ctx = { companyCode: company.code };
    const reference = issueReference(row.id);
    const found = await this.erp.findGoodsIssue(ctx, reference);
    const { externalCode } =
      found ??
      (await this.erp.createGoodsIssue(ctx, {
        reference,
        issuedOn: row.usedOn.toISOString().slice(0, 10),
        comment: `Connect the Dot เบิกอะไหล่งานบริการ ${reference}`,
        lines: [
          {
            itemCode: row.productCode,
            quantity: Number(row.quantity),
            warehouseCode: row.warehouseCode,
            serialNo: row.serialNo,
          },
        ],
      }));
    await this.mark(materialId, {
      erpStatus: 'synced',
      erpDocNo: externalCode,
      erpSyncedAt: new Date(),
      erpLastError: null,
    });
    await this.audit.record({
      eventType: 'integration.sap.goods_issue_synced',
      companyId: row.companyId,
      actorId: null,
      actorUsername: `sap-sync:${this.erp.mode}`,
      resourceType: 'service_material',
      resourceId: materialId,
      after: {
        reference,
        erpDocNo: externalCode,
        productCode: row.productCode,
        quantity: Number(row.quantity),
        warehouseCode: row.warehouseCode,
        adopted: Boolean(found),
      },
    });
    return externalCode;
  }

  async processQueue(): Promise<void> {
    const stale = (await this.materials.findMany({
      where: {
        erpStatus: 'pending',
        updatedAt: { lt: new Date(Date.now() - RECONCILE_AFTER_MS) },
      },
      select: { id: true },
      take: 50,
    })) as { id: string }[];
    for (const row of stale) {
      await enqueueErpJob(
        this.jobs,
        KINDS[0],
        row.id,
        'reconcile: pending ไม่มีงานในคิว',
      );
    }
    await sweepErpJobs(
      this.jobs,
      KINDS,
      async (job: ErpJobRow) => {
        await this.push(job.resourceId);
      },
      this.logger,
      (job, error, exhausted) =>
        this.mark(job.resourceId, {
          erpLastError: error,
          ...(exhausted ? { erpStatus: 'failed' } : {}),
        }),
    );
  }

  private async load(materialId: string) {
    const row = (await this.materials.findFirst({
      where: { id: materialId },
    })) as IssueRow | null;
    if (!row) throw new Error(`service material ${materialId} not found`);
    return row;
  }

  private async mark(
    materialId: string,
    data: Prisma.ServiceMaterialUseUpdateInput,
  ) {
    await this.materials.update({ where: { id: materialId }, data });
  }
}
