import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import {
  AppError,
  AuditWriter,
  auditActor,
  PrismaTransactionService,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import { ERP_CLIENT } from '../erp/erp-client';
import type { ErpClient } from '../erp/erp-client';
import { backgroundTick } from '../common/background-tick';
import { errorMessage } from './erp-sync-queue';
import {
  CompanyRepository,
  VendorCostRepository,
} from './product.repositories';
import { CrmConfigRepository } from './segment.repositories';
import { ProductCatalogService } from './product-catalog.service';
import {
  ageInDays,
  bestVendorCost,
  cleanManualCost,
  costIsStale,
  MANUAL_SOURCE,
  thaiToday,
  type ManualCost,
  type ManualCostInput,
  type VendorCostRow,
} from './vendor-costs';

/** First run after boot, out of the way of startup and the catalog sync. */
const FIRST_SYNC_DELAY_MS = 60_000;
/** Purchase orders this far back are read; older ones age out of the copy. */
const HISTORY_DAYS = 365;
const LOOKUP_LIMIT = 100;
const LIST_LIMIT = 500;

interface StoredCost {
  id: string;
  productCode: string;
  vendorCode: string;
  vendorName: string | null;
  source: string;
  unitCost: Prisma.Decimal;
  currency: string;
  docNo: string | null;
  costDate: Date;
  validTo: Date | null;
  syncedAt: Date;
}

/**
 * CD-206 — ต้นทุนจากคู่ค้า: suppliers' costs read from SAP with the date they
 * are from (the last purchase order, or a special price the supplier holds),
 * kept as a copy like the catalog (CD-27) so a quotation never waits on SAP
 * and still works when it is down.
 *
 * A cost older than the company's limit (CRM settings, default 90 days) is
 * marked stale wherever it shows — warned, never blocked.
 *
 * A company with no ERP connected yet types its costs in (source `manual`,
 * 12 Nov 2026): the same table, read by the same rule, never written by the
 * sync — so connecting SAP later adds rows beside them instead of replacing.
 */
@Injectable()
export class VendorCostService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VendorCostService.name);
  private timer: NodeJS.Timeout | null = null;
  private firstRun: NodeJS.Timeout | null = null;

  constructor(
    private readonly costs: VendorCostRepository,
    private readonly companies: CompanyRepository,
    private readonly configs: CrmConfigRepository,
    @Inject(ERP_CLIENT) private readonly erp: ErpClient,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
    private readonly config: ConfigService,
    private readonly catalog: ProductCatalogService,
  ) {}

  onModuleInit(): void {
    const everyMs =
      this.config.get<number>('erp.vendorCostsRefreshIntervalMs') ?? 21_600_000;
    // `0` disables — external-service and tests never sync.
    if (everyMs <= 0) return;
    const tick = backgroundTick(this.logger, 'SAP vendor cost sync', () =>
      this.syncAll(),
    );
    this.firstRun = setTimeout(tick, FIRST_SYNC_DELAY_MS);
    this.firstRun.unref?.();
    this.timer = setInterval(tick, everyMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.firstRun) clearTimeout(this.firstRun);
    if (this.timer) clearInterval(this.timer);
  }

  /** Every active company; one failing (SAP down, not mapped) skips only it. */
  async syncAll(): Promise<void> {
    const companies = (await this.companies.findMany({
      where: { active: true },
      select: { id: true, code: true },
    })) as { id: string; code: string }[];
    for (const company of companies) {
      try {
        const count = await this.syncCompany(company);
        this.logger.log(`vendor costs ${company.code}: ${count} row(s)`);
      } catch (error) {
        this.logger.warn(
          `vendor cost sync ${company.code} failed: ${errorMessage(error)}`,
        );
      }
    }
  }

  /** Upserts what SAP lists now; rows it no longer lists keep aging. */
  async syncCompany(company: { id: string; code: string }): Promise<number> {
    const today = thaiToday();
    const since = new Date(
      Date.parse(`${today}T00:00:00Z`) - HISTORY_DAYS * 86_400_000,
    )
      .toISOString()
      .slice(0, 10);
    const rows = await this.erp.listVendorCosts(
      { companyCode: company.code },
      since,
    );
    const now = new Date();
    await this.transactions.execute(async (prisma) => {
      for (const row of rows) {
        const data = {
          vendorName: row.vendorName,
          unitCost: row.unitCost,
          currency: row.currency,
          docNo: row.docNo,
          costDate: new Date(`${row.costDate}T00:00:00Z`),
          validTo: row.validTo ? new Date(`${row.validTo}T00:00:00Z`) : null,
          syncedAt: now,
        };
        await prisma.vendorCost.upsert({
          where: {
            companyId_productCode_vendorCode_source: {
              companyId: company.id,
              productCode: row.itemCode,
              vendorCode: row.vendorCode,
              source: row.source,
            },
          },
          create: {
            companyId: company.id,
            productCode: row.itemCode,
            vendorCode: row.vendorCode,
            source: row.source,
            ...data,
          },
          update: data,
        });
      }
    });
    return rows.length;
  }

  /** ปุ่ม "ดึงต้นทุนจาก SAP ตอนนี้" — the active company only. */
  async syncNow(actor: Principal) {
    const company = (await this.companies.findFirst({
      where: { id: actor.activeCompanyId },
      select: { id: true, code: true },
    })) as { id: string; code: string } | null;
    if (!company) throw new AppError('NOT_FOUND', 'ไม่พบบริษัทที่ทำงานอยู่');
    const total = await this.syncCompany(company);
    await this.audit.record({
      eventType: 'integration.sap.vendor_costs_synced',
      companyId: company.id,
      ...auditActor(actor),
      resourceType: 'company',
      resourceId: company.id,
      after: { total },
    });
    return { total };
  }

  /** The cost each product takes now, with its date and whether it is stale. */
  async lookup(actor: Principal, codes: readonly string[], currency = 'THB') {
    const wanted = [...new Set(codes.map((code) => code.trim()))]
      .filter(Boolean)
      .slice(0, LOOKUP_LIMIT);
    const maxAgeDays = await this.maxAgeDays(actor.activeCompanyId);
    if (!wanted.length) return { maxAgeDays, items: [] };
    const rows = await this.rowsFor(actor.activeCompanyId, wanted);
    const today = thaiToday();
    const items = wanted.flatMap((code) => {
      const best = bestVendorCost(
        rows.filter((row) => row.productCode === code),
        currency.toUpperCase(),
        today,
      );
      return best ? [view(best, maxAgeDays, today)] : [];
    });
    return { maxAgeDays, items };
  }

  /** The whole copy for the Pricing page, newest first. */
  async list(actor: Principal, query: { q?: string; stale?: string }) {
    const maxAgeDays = await this.maxAgeDays(actor.activeCompanyId);
    const q = query.q?.trim();
    const stored = (await this.costs.findMany({
      where: {
        companyId: actor.activeCompanyId,
        ...(q
          ? {
              OR: [
                { productCode: { contains: q, mode: 'insensitive' } },
                { vendorCode: { contains: q, mode: 'insensitive' } },
                { vendorName: { contains: q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: [{ costDate: 'desc' }, { productCode: 'asc' }],
      take: LIST_LIMIT,
    })) as StoredCost[];
    const today = thaiToday();
    let items = stored.map((row) => ({
      id: row.id,
      ...view(plain(row), maxAgeDays, today),
    }));
    if (query.stale === 'true') items = items.filter((item) => item.stale);
    const syncedAt = stored.reduce<Date | null>(
      (latest, row) =>
        !latest || row.syncedAt > latest ? row.syncedAt : latest,
      null,
    );
    return { maxAgeDays, syncedAt, items };
  }

  // --- typed-in costs ---------------------------------------------------------

  /** One typed-in cost per product and supplier; a second one is an edit. */
  async createManual(input: ManualCostInput, actor: Principal) {
    const companyId = actor.activeCompanyId;
    const value = this.cleanManual(input);
    await this.catalog.assertCodes(companyId, [
      { code: value.productCode, field: 'product_code' },
    ]);
    const id = await this.transactions.execute(async (prisma) => {
      await this.assertNoTwin(companyId, value, null, prisma);
      const row = (await this.costs.create(
        {
          data: {
            companyId,
            source: MANUAL_SOURCE,
            ...columns(value),
            syncedAt: new Date(),
          },
          select: { id: true },
        },
        { prisma },
      )) as { id: string };
      await this.audit.record(
        {
          eventType: 'pricing.vendor_cost.created',
          companyId,
          ...auditActor(actor),
          resourceType: 'vendor_cost',
          resourceId: row.id,
          after: { ...value },
        },
        { prisma },
      );
      return row.id;
    });
    return this.one(companyId, id);
  }

  /** A partial edit keeps what it does not name. SAP's rows are not editable. */
  async updateManual(id: string, input: ManualCostInput, actor: Principal) {
    const companyId = actor.activeCompanyId;
    const before = await this.requireManual(companyId, id);
    const value = this.cleanManual({
      product_code: before.productCode,
      vendor_code: before.vendorCode,
      vendor_name: before.vendorName,
      unit_cost: before.unitCost,
      currency: before.currency,
      cost_date: before.costDate,
      valid_to: before.validTo,
      doc_no: before.docNo,
      ...Object.fromEntries(
        Object.entries(input).filter(([, sent]) => sent !== undefined),
      ),
    });
    if (value.productCode !== before.productCode) {
      await this.catalog.assertCodes(companyId, [
        { code: value.productCode, field: 'product_code' },
      ]);
    }
    await this.transactions.execute(async (prisma) => {
      await this.assertNoTwin(companyId, value, id, prisma);
      await this.costs.update(
        { where: { id }, data: { ...columns(value), syncedAt: new Date() } },
        { prisma },
      );
      await this.audit.record(
        {
          eventType: 'pricing.vendor_cost.updated',
          companyId,
          ...auditActor(actor),
          resourceType: 'vendor_cost',
          resourceId: id,
          before: { ...before },
          after: { ...value },
        },
        { prisma },
      );
    });
    return this.one(companyId, id);
  }

  /**
   * Removes a typed-in cost. This table is a reference copy, not a
   * transaction — quotation lines keep the cost and source they were priced
   * on — and the audit entry keeps what was removed.
   */
  async removeManual(id: string, actor: Principal) {
    const companyId = actor.activeCompanyId;
    const before = await this.requireManual(companyId, id);
    await this.transactions.execute(async (prisma) => {
      await this.costs.delete({ where: { id } }, { prisma });
      await this.audit.record(
        {
          eventType: 'pricing.vendor_cost.deleted',
          companyId,
          ...auditActor(actor),
          resourceType: 'vendor_cost',
          resourceId: id,
          before: { ...before },
        },
        { prisma },
      );
    });
    return { id };
  }

  private cleanManual(input: ManualCostInput): ManualCost {
    const cleaned = cleanManualCost(input, thaiToday());
    if (!cleaned.ok) {
      throw new AppError(
        'VALIDATION_FAILED',
        'ข้อมูลต้นทุนไม่ถูกต้อง',
        cleaned.problems,
      );
    }
    return cleaned.value;
  }

  /** Another company's row, or one SAP wrote, answers 404 / 409. */
  private async requireManual(companyId: string, id: string) {
    const found = (await this.costs.findFirst({
      where: { id, companyId },
    })) as StoredCost | null;
    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบต้นทุนรายการนี้');
    if (found.source !== MANUAL_SOURCE) {
      throw new AppError(
        'CONFLICT',
        'ต้นทุนรายการนี้มาจาก SAP — แก้ที่ SAP แล้วดึงใหม่',
      );
    }
    return plain(found);
  }

  private async assertNoTwin(
    companyId: string,
    value: ManualCost,
    exceptId: string | null,
    prisma: Prisma.TransactionClient,
  ) {
    const twin = (await this.costs.findFirst(
      {
        where: {
          companyId,
          productCode: value.productCode,
          vendorCode: value.vendorCode,
          source: MANUAL_SOURCE,
          ...(exceptId ? { id: { not: exceptId } } : {}),
        },
        select: { id: true },
      },
      { prisma },
    )) as { id: string } | null;
    if (twin) {
      throw new AppError(
        'CONFLICT',
        `มีต้นทุนที่กรอกเองของ ${value.productCode} จากผู้ขาย ${value.vendorName} อยู่แล้ว — แก้รายการเดิม`,
        [{ field: 'vendor_name', reason: 'duplicate' }],
      );
    }
  }

  private async one(companyId: string, id: string) {
    const row = (await this.costs.findFirst({
      where: { id, companyId },
    })) as StoredCost;
    const today = thaiToday();
    return {
      id: row.id,
      ...view(plain(row), await this.maxAgeDays(companyId), today),
    };
  }

  /** For the quotation: every stored cost of these products, as plain rows. */
  async rowsFor(companyId: string, codes: readonly string[]) {
    if (!codes.length) return [];
    return (
      (await this.costs.findMany({
        where: { companyId, productCode: { in: [...codes] } },
      })) as StoredCost[]
    ).map(plain);
  }

  async maxAgeDays(companyId: string): Promise<number> {
    const found = (await this.configs.findFirst({
      where: { companyId },
      select: { costMaxAgeDays: true },
    })) as { costMaxAgeDays: number } | null;
    return found?.costMaxAgeDays ?? 90;
  }
}

function columns(value: ManualCost) {
  return {
    productCode: value.productCode,
    vendorCode: value.vendorCode,
    vendorName: value.vendorName,
    unitCost: value.unitCost,
    currency: value.currency,
    docNo: value.docNo,
    costDate: new Date(`${value.costDate}T00:00:00Z`),
    validTo: value.validTo ? new Date(`${value.validTo}T00:00:00Z`) : null,
  };
}

function day(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function plain(row: StoredCost): VendorCostRow {
  return {
    productCode: row.productCode,
    vendorCode: row.vendorCode,
    vendorName: row.vendorName,
    source: row.source,
    unitCost: Number(row.unitCost),
    currency: row.currency,
    docNo: row.docNo,
    costDate: day(row.costDate),
    validTo: row.validTo ? day(row.validTo) : null,
  };
}

/** `unitCost` is masked like a quotation's cost (SensitiveResource quotation). */
function view(row: VendorCostRow, maxAgeDays: number, today: string) {
  return {
    ...row,
    ageDays: ageInDays(row.costDate, today),
    stale: costIsStale(row.costDate, maxAgeDays, today),
  };
}
