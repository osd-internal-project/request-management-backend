import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import {
  AppError,
  AuditWriter,
  auditActor,
  Principal,
  PrismaTransactionService,
} from '@request-management/share';
import { CompanyMemberRepository } from '../access/company-member.repository';
import { backgroundTick } from '../common/background-tick';
import { CompanyRepository } from '../crm/product.repositories';
import { thaiToday } from '../crm/vendor-costs';
import { ERP_CLIENT } from '../erp/erp-client';
import type { ErpClient, ErpVendor } from '../erp/erp-client';
import { NotificationsService } from '../notifications/notifications.service';
import { RequestRepository } from '../requests/request.repository';
import { serialKey } from './asset-rules';
import {
  CLAIM_OPEN,
  claimOverdue,
  replaceProblems,
  stepProblems,
} from './claim-rules';
import {
  ClaimStepDto,
  ListClaimsQueryDto,
  OpenClaimDto,
  ReplaceUnitDto,
} from './support.dto';
import {
  ServiceAssetRepository,
  ServiceClaimRepository,
  ServiceWorkOrderRepository,
} from './support.repositories';

interface ClaimRow {
  id: string;
  companyId: string;
  workOrderId: string | null;
  requestId: string | null;
  assetId: string | null;
  productCode: string | null;
  description: string;
  serialNo: string | null;
  vendorCode: string;
  vendorName: string;
  rmaNo: string | null;
  status: string;
  sentOn: Date | null;
  expectedOn: Date | null;
  resolvedOn: Date | null;
  replacementSerial: string | null;
  creditAmount: Prisma.Decimal | null;
  outcomeNote: string | null;
  overdueNotifiedAt: Date | null;
  createdAt: Date;
  createdBy: string;
}

interface AssetRow {
  id: string;
  companyId: string;
  customerId: string;
  name: string;
  productCode: string | null;
  serialNo: string | null;
  status: string;
}

const day = (value: Date | null) =>
  value ? value.toISOString().slice(0, 10) : null;
const asDate = (value: string | null | undefined) =>
  value ? new Date(`${value}T00:00:00Z`) : null;
const VENDOR_CACHE_MS = 60 * 60_000;

/**
 * CD-245 อะไหล่และการเคลม — the unit swapped on a service job and the faulty
 * one sent back to its supplier:
 *
 * - a replacement keeps the asset (its place, its warranty and contract —
 *   CD-236/237) and changes its serial, the old one kept in its history with
 *   the job; the faulty unit may go straight onto a claim;
 * - a claim: the supplier (from SAP's vendors), their RMA number, sent on,
 *   expected back; then replaced, credited or rejected — each step with what
 *   it needs; sent and past the expected day, whoever raised it is told once.
 *
 * Spares out of stock are goods issues in SAP ({@link SpareIssueErpSyncService});
 * stock moves there, not here.
 *
 * Who: `service.asset.read` reads; `service.asset.manage` replaces and claims.
 */
@Injectable()
export class ClaimsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ClaimsService.name);
  private timer: NodeJS.Timeout | null = null;
  private readonly vendorCache = new Map<
    string,
    { at: number; rows: ErpVendor[] }
  >();

  constructor(
    private readonly claims: ServiceClaimRepository,
    private readonly assets: ServiceAssetRepository,
    private readonly orders: ServiceWorkOrderRepository,
    private readonly requestRows: RequestRepository,
    private readonly companies: CompanyRepository,
    private readonly people: CompanyMemberRepository,
    @Inject(ERP_CLIENT) private readonly erp: ErpClient,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const everyMs =
      this.config.get<number>('service.claimSweepIntervalMs') ?? 3_600_000;
    if (everyMs <= 0) return;
    this.timer = setInterval(
      backgroundTick(this.logger, 'claim overdue sweep', () => this.sweep()),
      everyMs,
    );
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * The faulty unit out, a new one in: the asset keeps its place and cover,
   * its serial changes, the history says which job did it. With `claim`, the
   * faulty unit goes onto a claim to its supplier in the same step.
   */
  async replaceUnit(actor: Principal, assetId: string, dto: ReplaceUnitDto) {
    const companyId = actor.activeCompanyId;
    const asset = (await this.assets.findFirst({
      where: { id: assetId, companyId },
    })) as AssetRow | null;
    if (!asset) throw new AppError('NOT_FOUND', 'ไม่พบอุปกรณ์ที่ระบุ');
    if (asset.status !== 'active') {
      throw new AppError(
        'CONFLICT',
        'เปลี่ยนเครื่องได้เฉพาะอุปกรณ์ที่ใช้งานอยู่',
      );
    }
    const newSerial = serialKey(dto.new_serial);
    const problems = replaceProblems({
      oldSerial: asset.serialNo,
      newSerial,
      reason: dto.reason,
    });
    if (problems.length) throw new AppError('VALIDATION_FAILED', problems[0]);
    if (
      await this.assets.count({
        where: { companyId, serialNo: newSerial, id: { not: assetId } },
      })
    ) {
      throw new AppError(
        'CONFLICT',
        `หมายเลขเครื่อง ${newSerial} มีในทะเบียนแล้ว`,
      );
    }
    const order = dto.work_order_id
      ? await this.requireOrder(companyId, dto.work_order_id)
      : null;
    if (dto.claim && !dto.claim.vendor_code) {
      throw new AppError('VALIDATION_FAILED', 'ส่งเคลมต้องระบุคู่ค้า');
    }
    const claimId = await this.transactions.execute(async (prisma) => {
      await prisma.serviceAsset.update({
        where: { id: assetId },
        data: { serialNo: newSerial, updatedBy: actor.userId },
      });
      await prisma.serviceAssetHistory.create({
        data: {
          companyId,
          assetId,
          action: 'replaced',
          before: { serialNo: asset.serialNo },
          after: {
            serialNo: newSerial,
            workOrderId: order?.id ?? null,
            requestId: order?.requestId ?? null,
          },
          reason: dto.reason.trim(),
          actorId: actor.userId,
        },
      });
      let created: { id: string } | null = null;
      if (dto.claim) {
        created = await prisma.serviceClaim.create({
          data: {
            companyId,
            workOrderId: order?.id ?? null,
            requestId: order?.requestId ?? null,
            assetId,
            productCode: asset.productCode,
            description: asset.name,
            serialNo: asset.serialNo,
            vendorCode: dto.claim.vendor_code,
            vendorName: dto.claim.vendor_name?.trim() || dto.claim.vendor_code,
            createdBy: actor.userId,
          },
          select: { id: true },
        });
      }
      await this.audit.record(
        {
          eventType: 'service.asset.replaced',
          companyId,
          ...auditActor(actor),
          resourceType: 'service_asset',
          resourceId: assetId,
          before: { serialNo: asset.serialNo },
          after: {
            serialNo: newSerial,
            workOrderId: order?.id ?? null,
            claimId: created?.id ?? null,
          },
        },
        { prisma },
      );
      return created?.id ?? null;
    });
    return {
      assetId,
      oldSerial: asset.serialNo,
      newSerial,
      claim: claimId ? await this.detail(actor, claimId) : null,
    };
  }

  /** A claim on its own (a spare that failed, a unit swapped earlier). */
  async open(actor: Principal, dto: OpenClaimDto) {
    const companyId = actor.activeCompanyId;
    const order = dto.work_order_id
      ? await this.requireOrder(companyId, dto.work_order_id)
      : null;
    const asset = dto.asset_id
      ? ((await this.assets.findFirst({
          where: { id: dto.asset_id, companyId },
        })) as AssetRow | null)
      : null;
    if (dto.asset_id && !asset) {
      throw new AppError('NOT_FOUND', 'ไม่พบอุปกรณ์ที่ระบุ');
    }
    const row = await this.transactions.execute(async (prisma) => {
      const created = await prisma.serviceClaim.create({
        data: {
          companyId,
          workOrderId: order?.id ?? null,
          requestId: order?.requestId ?? null,
          assetId: asset?.id ?? null,
          productCode: dto.product_code?.trim() || asset?.productCode || null,
          description: dto.description.trim(),
          serialNo: dto.serial_no?.trim() || null,
          vendorCode: dto.vendor_code,
          vendorName: dto.vendor_name?.trim() || dto.vendor_code,
          createdBy: actor.userId,
        },
        select: { id: true },
      });
      await this.audit.record(
        {
          eventType: 'service.claim.opened',
          companyId,
          ...auditActor(actor),
          resourceType: 'service_claim',
          resourceId: created.id,
          after: {
            vendorCode: dto.vendor_code,
            serialNo: dto.serial_no ?? null,
          },
        },
        { prisma },
      );
      return created;
    });
    return this.detail(actor, row.id);
  }

  /** The next step: sent (with RMA), then replaced / credited / rejected, or cancelled. */
  async step(actor: Principal, id: string, dto: ClaimStepDto) {
    const before = await this.require(actor.activeCompanyId, id);
    const problems = stepProblems(before.status, {
      to: dto.status,
      sentOn: dto.sent_on,
      expectedOn: dto.expected_on,
      resolvedOn: dto.resolved_on,
      creditAmount: dto.credit_amount,
      outcomeNote: dto.outcome_note,
    });
    if (problems.length) throw new AppError('VALIDATION_FAILED', problems[0]);
    await this.transactions.execute(async (prisma) => {
      await prisma.serviceClaim.update({
        where: { id },
        data: {
          status: dto.status,
          ...(dto.rma_no !== undefined
            ? { rmaNo: dto.rma_no?.trim() || null }
            : {}),
          ...(dto.sent_on ? { sentOn: asDate(dto.sent_on) } : {}),
          ...(dto.expected_on !== undefined
            ? { expectedOn: asDate(dto.expected_on) }
            : {}),
          ...(dto.resolved_on ? { resolvedOn: asDate(dto.resolved_on) } : {}),
          ...(dto.replacement_serial !== undefined
            ? { replacementSerial: dto.replacement_serial?.trim() || null }
            : {}),
          ...(dto.credit_amount !== undefined
            ? { creditAmount: dto.credit_amount }
            : {}),
          ...(dto.outcome_note !== undefined
            ? { outcomeNote: dto.outcome_note?.trim() || null }
            : {}),
          updatedBy: actor.userId,
        },
      });
      await this.audit.record(
        {
          eventType: 'service.claim.step',
          companyId: before.companyId,
          ...auditActor(actor),
          resourceType: 'service_claim',
          resourceId: id,
          before: { status: before.status },
          after: { ...dto },
        },
        { prisma },
      );
    });
    return this.detail(actor, id);
  }

  async list(actor: Principal, query: ListClaimsQueryDto) {
    const companyId = actor.activeCompanyId;
    const today = thaiToday();
    const where: Prisma.ServiceClaimWhereInput = { companyId };
    if (query.state === 'open') where.status = { in: [...CLAIM_OPEN] };
    else if (query.state === 'overdue') {
      where.status = 'sent';
      where.expectedOn = { lt: asDate(today)! };
    } else if (query.state === 'closed') {
      where.status = { notIn: [...CLAIM_OPEN] };
    }
    if (query.work_order_id) where.workOrderId = query.work_order_id;
    const rows = (await this.claims.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }],
      take: 300,
    })) as ClaimRow[];
    return this.views(rows);
  }

  async detail(actor: Principal, id: string) {
    const [view] = await this.views([
      await this.require(actor.activeCompanyId, id),
    ]);
    return view;
  }

  /** Suppliers from SAP for the claim form, an hour's copy per company. */
  async vendors(actor: Principal) {
    const companyId = actor.activeCompanyId;
    const cached = this.vendorCache.get(companyId);
    if (cached && Date.now() - cached.at < VENDOR_CACHE_MS) {
      return cached.rows.filter((row) => row.active);
    }
    const company = (await this.companies.findFirst({
      where: { id: companyId },
      select: { code: true },
    })) as { code: string } | null;
    if (!company) throw new AppError('NOT_FOUND', 'ไม่พบบริษัท');
    try {
      const rows = await this.erp.listVendors({ companyCode: company.code });
      this.vendorCache.set(companyId, { at: Date.now(), rows });
      return rows.filter((row) => row.active);
    } catch (error) {
      throw new AppError(
        'UPSTREAM_ERROR',
        `อ่านรายชื่อคู่ค้าจาก SAP ไม่ได้: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Sent and past the day expected back: whoever raised it is told once. */
  async sweep(now = new Date()) {
    const today = thaiToday(now);
    const late = (await this.claims.findMany({
      where: {
        status: 'sent',
        expectedOn: { lt: asDate(today)! },
        overdueNotifiedAt: null,
      },
      take: 100,
    })) as ClaimRow[];
    let told = 0;
    for (const claim of late) {
      if (
        !claimOverdue(
          { status: claim.status, expectedOn: day(claim.expectedOn) },
          today,
        )
      ) {
        continue;
      }
      const claimed = await this.claims.updateMany({
        where: { id: claim.id, overdueNotifiedAt: null },
        data: { overdueNotifiedAt: now },
      });
      if (claimed.count !== 1) continue;
      await this.notifications
        .claimOverdue(claim.createdBy, claim.companyId, {
          claimId: claim.id,
          vendorName: claim.vendorName,
          description: claim.description,
          serialNo: claim.serialNo ?? '',
          rmaNo: claim.rmaNo ?? '',
          expectedOn: day(claim.expectedOn) ?? '',
        })
        .catch((error: Error) =>
          this.logger.warn(`claim notice not sent: ${error.message}`),
        );
      told += 1;
    }
    return { told };
  }

  // --- helpers ---------------------------------------------------------------

  private async views(rows: ClaimRow[]) {
    const today = thaiToday();
    const [cases, names] = await Promise.all([
      this.requestRows.findMany({
        where: {
          id: {
            in: rows.flatMap((row) => (row.requestId ? [row.requestId] : [])),
          },
        },
        select: { id: true, requestNo: true },
      }) as Promise<{ id: string; requestNo: string | null }[]>,
      this.names(rows.map((row) => row.createdBy)),
    ]);
    const caseById = new Map(cases.map((row) => [row.id, row.requestNo]));
    return rows.map((row) => ({
      id: row.id,
      workOrderId: row.workOrderId,
      requestId: row.requestId,
      requestNo: row.requestId ? (caseById.get(row.requestId) ?? null) : null,
      assetId: row.assetId,
      productCode: row.productCode,
      description: row.description,
      serialNo: row.serialNo,
      vendorCode: row.vendorCode,
      vendorName: row.vendorName,
      rmaNo: row.rmaNo,
      status: row.status,
      overdue: claimOverdue(
        { status: row.status, expectedOn: day(row.expectedOn) },
        today,
      ),
      sentOn: day(row.sentOn),
      expectedOn: day(row.expectedOn),
      resolvedOn: day(row.resolvedOn),
      replacementSerial: row.replacementSerial,
      creditAmount: row.creditAmount === null ? null : Number(row.creditAmount),
      outcomeNote: row.outcomeNote,
      createdAt: row.createdAt.toISOString(),
      createdByName: names.get(row.createdBy) ?? row.createdBy,
    }));
  }

  private async require(companyId: string, id: string) {
    const row = (await this.claims.findFirst({
      where: { id, companyId },
    })) as ClaimRow | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบเคลม');
    return row;
  }

  private async requireOrder(companyId: string, id: string) {
    const row = (await this.orders.findFirst({
      where: { id, companyId },
      select: { id: true, requestId: true },
    })) as { id: string; requestId: string } | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบใบสั่งงานบริการ');
    return row;
  }

  private async names(ids: (string | null)[]) {
    const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    if (!unique.length) return new Map<string, string>();
    const users = (await this.people.findMany({
      where: { id: { in: unique } },
      select: { id: true, displayName: true },
    })) as { id: string; displayName: string }[];
    return new Map(users.map((user) => [user.id, user.displayName]));
  }
}
