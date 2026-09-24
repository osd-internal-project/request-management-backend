import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppError, AuditWriter, auditActor } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { ERP_CLIENT } from '../erp/erp-client';
import type { ErpClient } from '../erp/erp-client';
import { errorMessage } from './erp-sync-queue';
import { CompanyRepository, ProductRepository } from './product.repositories';

/** How long after boot the first sync runs — out of the way of startup. */
const FIRST_SYNC_DELAY_MS = 15_000;
const SEARCH_LIMIT = 50;

export interface CatalogSyncResult {
  total: number;
  created: number;
  updated: number;
  deactivated: number;
}

interface ProductRow {
  code: string;
  name: string;
  unit: string | null;
  active: boolean;
}

/**
 * CD-27 — สินค้า/บริการจาก SAP เก็บสำเนาไว้ที่ Connect the Dot.
 *
 *   - SAP เป็นเจ้าของ: รอบ sync (รายชั่วโมง + ครั้งแรกหลัง start + ปุ่มในหน้า
 *     ผู้ดูแล) ดึง `Items` ที่ขายได้ของแต่ละบริษัทมาเทียบ — ใหม่ = สร้าง, เปลี่ยน =
 *     แก้, หายไปจาก SAP = `active = false` (ไม่ลบ: บรรทัดเก่ายังอ้างรหัสนี้อยู่);
 *   - ใช้ได้แม้ SAP ล่ม: หน้าจอค้นจากตารางนี้ ไม่เรียก SAP สด;
 *   - รหัสบนบรรทัดใบเสนอราคาต้องเป็นรหัสที่ SAP รู้จักและยังขายอยู่ — ไม่งั้น
 *     ใบสั่งขายที่ตามมาจะถูก SAP ปฏิเสธตอนส่ง. ตรวจเมื่อบริษัทนั้น sync แล้ว
 *     อย่างน้อยครั้งหนึ่งเท่านั้น (ยังไม่เคย sync = ยังไม่มีอะไรให้เทียบ).
 */
@Injectable()
export class ProductCatalogService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProductCatalogService.name);
  private timer: NodeJS.Timeout | null = null;
  private firstRun: NodeJS.Timeout | null = null;

  constructor(
    private readonly products: ProductRepository,
    private readonly companies: CompanyRepository,
    @Inject(ERP_CLIENT) private readonly erp: ErpClient,
    private readonly audit: AuditWriter,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const everyMs =
      this.config.get<number>('erp.itemsRefreshIntervalMs') ?? 3_600_000;
    // `0` disables — external-service and tests never sync the catalog.
    if (everyMs <= 0) return;

    this.firstRun = setTimeout(() => void this.syncAll(), FIRST_SYNC_DELAY_MS);
    this.firstRun.unref?.();
    this.timer = setInterval(() => void this.syncAll(), everyMs);
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
        const result = await this.syncCompany(company);
        this.logger.log(
          `catalog ${company.code}: ${result.total} item(s), +${result.created} ~${result.updated} -${result.deactivated}`,
        );
      } catch (error) {
        this.logger.warn(
          `catalog sync ${company.code} failed: ${errorMessage(error)}`,
        );
      }
    }
  }

  async syncCompany(company: {
    id: string;
    code: string;
  }): Promise<CatalogSyncResult> {
    const items = await this.erp.listItems({ companyCode: company.code });
    const existing = (await this.products.findMany({
      where: { companyId: company.id },
      select: { code: true, name: true, unit: true, active: true },
    })) as ProductRow[];

    const byCode = new Map(existing.map((row) => [row.code, row]));
    const seen = new Set<string>();
    const now = new Date();
    const toCreate: ProductRow[] = [];
    let updated = 0;

    for (const item of items) {
      if (seen.has(item.code)) continue;
      seen.add(item.code);
      const row = byCode.get(item.code);
      if (!row) {
        toCreate.push(item);
      } else if (
        row.name !== item.name ||
        row.unit !== item.unit ||
        row.active !== item.active
      ) {
        await this.products.update({
          where: { companyId_code: { companyId: company.id, code: item.code } },
          data: {
            name: item.name,
            unit: item.unit,
            active: item.active,
            syncedAt: now,
          },
        });
        updated += 1;
      }
    }

    if (toCreate.length) {
      await this.products.createMany({
        data: toCreate.map((item) => ({
          companyId: company.id,
          code: item.code,
          name: item.name,
          unit: item.unit,
          active: item.active,
          syncedAt: now,
        })),
        skipDuplicates: true,
      });
    }

    // Everything SAP still lists was seen now, changed or not.
    await this.products.updateMany({
      where: { companyId: company.id, code: { in: [...seen] } },
      data: { syncedAt: now },
    });

    const gone = existing
      .filter((row) => row.active && !seen.has(row.code))
      .map((row) => row.code);
    if (gone.length) {
      await this.products.updateMany({
        where: { companyId: company.id, code: { in: gone } },
        data: { active: false },
      });
    }

    return {
      total: seen.size,
      created: toCreate.length,
      updated,
      deactivated: gone.length,
    };
  }

  /** ปุ่ม "ดึงจาก SAP ตอนนี้" ในหน้าผู้ดูแล — บริษัทที่ทำงานอยู่เท่านั้น. */
  async syncNow(actor: Principal): Promise<CatalogSyncResult> {
    const company = (await this.companies.findFirst({
      where: { id: actor.activeCompanyId },
      select: { id: true, code: true },
    })) as { id: string; code: string } | null;
    if (!company) throw new AppError('NOT_FOUND', 'ไม่พบบริษัทที่ทำงานอยู่');

    const result = await this.syncCompany(company);

    await this.audit.record({
      eventType: 'integration.sap.catalog_synced',
      companyId: company.id,
      ...auditActor(actor),
      resourceType: 'company',
      resourceId: company.id,
      after: { ...result },
    });
    return result;
  }

  /** สรุปสำหรับหน้าผู้ดูแล — มีกี่รายการ ขายได้กี่รายการ sync ล่าสุดเมื่อไร. */
  async status(actor: Principal) {
    const where = { companyId: actor.activeCompanyId };
    const [total, active, latest] = await Promise.all([
      this.products.count({ where }),
      this.products.count({ where: { ...where, active: true } }),
      this.products.findFirst({
        where,
        orderBy: { syncedAt: 'desc' },
        select: { syncedAt: true },
      }) as Promise<{ syncedAt: Date } | null>,
    ]);
    return { total, active, lastSyncedAt: latest?.syncedAt ?? null };
  }

  /** ช่องเลือกสินค้าบนบรรทัด — ค้นรหัสหรือชื่อ ในบริษัทที่ทำงานอยู่. */
  async search(
    actor: Principal,
    query: { search?: string; includeInactive?: boolean },
  ) {
    const term = query.search?.trim();
    return this.products.findMany({
      where: {
        companyId: actor.activeCompanyId,
        ...(query.includeInactive ? {} : { active: true }),
        ...(term
          ? {
              OR: [
                { code: { contains: term, mode: 'insensitive' } },
                { name: { contains: term, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      select: { code: true, name: true, unit: true, active: true },
      orderBy: { code: 'asc' },
      take: SEARCH_LIMIT,
    });
  }

  /**
   * รหัสบนบรรทัดต้องอยู่ในรายการสินค้าจาก SAP และยังขายอยู่. บรรทัดไม่มีรหัส
   * (บริการ/ค่าแรง) ผ่าน; บริษัทที่ยังไม่เคย sync ผ่านทั้งหมด.
   */
  async assertKnownCodes(
    companyId: string,
    lines: readonly { product_code?: string | null }[],
  ): Promise<void> {
    const codes = [
      ...new Set(
        lines
          .map((line) => line.product_code?.trim())
          .filter((code): code is string => Boolean(code)),
      ),
    ];
    if (!codes.length) return;

    const synced = await this.products.count({ where: { companyId } });
    if (!synced) return;

    const known = (await this.products.findMany({
      where: { companyId, code: { in: codes }, active: true },
      select: { code: true },
    })) as { code: string }[];
    const ok = new Set(known.map((row) => row.code));

    const details = lines.flatMap((line, index) => {
      const code = line.product_code?.trim();
      return code && !ok.has(code)
        ? [{ field: `lines[${index}].product_code`, reason: code }]
        : [];
    });
    if (details.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        `รหัสสินค้าไม่อยู่ในรายการสินค้าจาก SAP หรือเลิกขายแล้ว: ${details
          .map((d) => d.reason)
          .join(', ')}`,
        details,
      );
    }
  }
}
