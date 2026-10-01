import { Injectable } from '@nestjs/common';
import {
  AppError,
  AuditWriter,
  auditActor,
  Principal,
  PrismaTransactionService,
} from '@request-management/share';
import type { TQueryClient } from '@request-management/share';
import { ProductCatalogService } from '../crm/product-catalog.service';
import { ProductRepository } from '../crm/product.repositories';
import {
  ProductPriceRepository,
  ProductPriceVersionRepository,
} from './pricing.repositories';
import {
  cleanPrice,
  dayBefore,
  dayOf,
  hasStarted,
  MAX_REASON,
  revisionProblems,
  startedEditProblems,
  isIsoDate,
  overlaps,
  priceOn,
  priceStatus,
  type CleanPrice,
  type PriceInput,
  type PriceStatus,
} from './price-rules';

interface PriceRow {
  id: string;
  productCode: string;
  priceModel: string;
  currency: string;
  unitPrice: unknown;
  validFrom: Date;
  validTo: Date | null;
  note: string;
  createdBy: string;
  updatedAt: Date;
  updatedBy: string | null;
}

const PRICE_SELECT = {
  id: true,
  productCode: true,
  priceModel: true,
  currency: true,
  unitPrice: true,
  validFrom: true,
  validTo: true,
  note: true,
  createdBy: true,
  updatedAt: true,
  updatedBy: true,
} as const;

const LIST_LIMIT = 500;
const LOOKUP_LIMIT = 200;
const today = () => new Date().toISOString().slice(0, 10);
const day = (value: string) => new Date(`${value}T00:00:00Z`);

/**
 * CD-194 — รายการราคามาตรฐาน (user decisions 30 ก.ย. 2569):
 *
 * - Pricing keeps the list in Connect the Dot; SAP owns only the product
 *   list, so a price is for a code the catalog knows (once it has synced);
 * - one row is a price of one product code in one currency for a range of
 *   whole days, `validTo` included and open-ended when empty. Ranges of the
 *   same code and currency never overlap — the save that would is refused
 *   naming the row it collides with;
 * - `pricing.price.manage` keeps the list, `pricing.price.read` sees it; the
 *   quotation form looks up today's price with `crm.sales.read` and fills
 *   the line's unit price (the salesperson may still change it — CD-204).
 *
 * CD-195 — อายุและเวอร์ชันราคา (user decisions 30 ก.ย. 2569):
 *
 * - every save writes a row to `product_price_versions` — the price as it
 *   stood after the change, who, when and why;
 * - a price that has reached its first day is history: only its end may
 *   change, never into the past, and with a reason. Changing the amount is
 *   a revision — the old row ends the day before, a new row carries on —
 *   and a started price cannot be deleted;
 * - a quotation line remembers the price it came from, and the quotation
 *   cannot be submitted while that price is no longer in effect.
 */
@Injectable()
export class PricesService {
  constructor(
    private readonly prices: ProductPriceRepository,
    private readonly versions: ProductPriceVersionRepository,
    private readonly products: ProductRepository,
    private readonly catalog: ProductCatalogService,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  // --- reading ------------------------------------------------------------------

  async list(
    actor: Principal,
    query: { q?: string; status?: PriceStatus; productCode?: string },
  ) {
    const companyId = actor.activeCompanyId;
    const term = query.q?.trim();
    const matching = term
      ? ((await this.products.findMany({
          where: {
            companyId,
            OR: [
              { code: { contains: term, mode: 'insensitive' } },
              { name: { contains: term, mode: 'insensitive' } },
            ],
          },
          select: { code: true },
          take: LIST_LIMIT,
        })) as { code: string }[])
      : null;
    const rows = (await this.prices.findMany({
      where: {
        companyId,
        deletedAt: null,
        ...(query.productCode ? { productCode: query.productCode } : {}),
        ...(term
          ? {
              OR: [
                { productCode: { contains: term, mode: 'insensitive' } },
                { productCode: { in: matching!.map((row) => row.code) } },
              ],
            }
          : {}),
      },
      orderBy: [
        { productCode: 'asc' },
        { currency: 'asc' },
        { validFrom: 'desc' },
      ],
      select: PRICE_SELECT,
      take: LIST_LIMIT,
    })) as PriceRow[];
    const names = await this.namesOf(
      companyId,
      rows.map((row) => row.productCode),
    );
    const now = today();
    return rows
      .map((row) => this.present(row, names, now))
      .filter((row) => !query.status || row.status === query.status);
  }

  /**
   * The price of each code on `on` (default today) in `currency` — for the
   * quotation form. Codes without a price in effect are left out.
   */
  async lookup(
    actor: Principal,
    codes: readonly string[],
    currency = 'THB',
    on?: string,
  ) {
    const wanted = [...new Set(codes.map((code) => code.trim()))]
      .filter(Boolean)
      .slice(0, LOOKUP_LIMIT);
    if (on !== undefined && !isIsoDate(on)) {
      throw new AppError('VALIDATION_FAILED', 'วันที่ไม่ถูกต้อง', [
        { field: 'on', reason: 'invalid_date' },
      ]);
    }
    if (!wanted.length) return {};
    const date = on ?? today();
    const rows = (await this.prices.findMany({
      where: {
        companyId: actor.activeCompanyId,
        deletedAt: null,
        productCode: { in: wanted },
        currency: currency.toUpperCase(),
        validFrom: { lte: day(date) },
        OR: [{ validTo: null }, { validTo: { gte: day(date) } }],
      },
      select: PRICE_SELECT,
    })) as PriceRow[];
    const result: Record<
      string,
      {
        price_id: string;
        price_model: string;
        unit_price: number;
        currency: string;
        valid_from: string;
        valid_to: string | null;
      }
    > = {};
    for (const code of wanted) {
      const found = priceOn(
        rows
          .filter((row) => row.productCode === code)
          .map((row) => ({ ...row, ...this.rangeOf(row) })),
        date,
      );
      if (found) {
        result[code] = {
          price_id: found.id,
          price_model: found.priceModel,
          unit_price: Number(found.unitPrice),
          currency: found.currency,
          valid_from: found.validFrom,
          valid_to: found.validTo,
        };
      }
    }
    return result;
  }

  // --- writing ------------------------------------------------------------------

  async create(input: PriceInput, actor: Principal) {
    const value = this.clean(input);
    const companyId = actor.activeCompanyId;
    await this.catalog.assertCodes(companyId, [
      { code: value.productCode, field: 'product_code' },
    ]);
    const created = await this.transactions.execute(async (prisma) => {
      await this.assertNoOverlap(companyId, value, null, prisma);
      const row = (await this.prices.create(
        {
          data: {
            companyId,
            productCode: value.productCode,
            priceModel: value.priceModel,
            currency: value.currency,
            unitPrice: value.unitPrice,
            validFrom: day(value.validFrom),
            validTo: value.validTo ? day(value.validTo) : null,
            note: value.note,
            createdBy: actor.userId,
          },
          select: PRICE_SELECT,
        },
        { prisma },
      )) as PriceRow;
      await this.writeVersion(
        row.id,
        companyId,
        'created',
        value,
        '',
        actor,
        prisma,
      );
      await this.audit.record(
        {
          eventType: 'pricing.price.created',
          companyId,
          ...auditActor(actor),
          resourceType: 'product_price',
          resourceId: row.id,
          after: { ...value },
        },
        { prisma },
      );
      return row;
    });
    return this.one(companyId, created.id);
  }

  async update(
    id: string,
    input: PriceInput & { reason?: unknown },
    actor: Principal,
  ) {
    const companyId = actor.activeCompanyId;
    const existing = await this.require(companyId, id);
    const before = this.snapshot(existing);
    // A partial edit keeps what it does not name.
    const value = this.clean({ ...before, ...input });
    const now = today();
    const started = hasStarted(before, now);
    const reason = this.reasonOf(input.reason, started);
    if (started) {
      const problems = startedEditProblems(before, value, now);
      if (problems.length) {
        throw new AppError(
          'CONFLICT',
          'ราคานี้มีผลแล้ว — แก้ได้เฉพาะวันสิ้นสุด (ไม่ย้อนก่อนเมื่อวาน) ถ้าจะเปลี่ยนราคาให้ใช้ "ปรับราคา"',
          problems,
        );
      }
    }
    if (value.productCode !== existing.productCode) {
      await this.catalog.assertCodes(companyId, [
        { code: value.productCode, field: 'product_code' },
      ]);
    }
    await this.transactions.execute(async (prisma) => {
      await this.assertNoOverlap(companyId, value, id, prisma);
      await this.prices.update(
        {
          where: { id },
          data: {
            productCode: value.productCode,
            priceModel: value.priceModel,
            currency: value.currency,
            unitPrice: value.unitPrice,
            validFrom: day(value.validFrom),
            validTo: value.validTo ? day(value.validTo) : null,
            note: value.note,
            updatedBy: actor.userId,
          },
        },
        { prisma },
      );
      await this.writeVersion(
        id,
        companyId,
        started ? 'ended' : 'updated',
        value,
        reason,
        actor,
        prisma,
      );
      await this.audit.record(
        {
          eventType: 'pricing.price.updated',
          companyId,
          ...auditActor(actor),
          resourceType: 'product_price',
          resourceId: id,
          before: this.snapshot(existing),
          after: { ...value },
        },
        { prisma },
      );
    });
    return this.one(companyId, id);
  }

  /** Soft delete of a price not yet in effect — a started one is history. */
  async remove(id: string, actor: Principal) {
    const companyId = actor.activeCompanyId;
    const existing = await this.require(companyId, id);
    if (hasStarted(this.rangeOf(existing), today())) {
      throw new AppError(
        'CONFLICT',
        'ราคานี้มีผลแล้ว ลบไม่ได้ — ปิดด้วยวันสิ้นสุดแทน',
      );
    }
    await this.transactions.execute(async (prisma) => {
      await this.writeVersion(
        id,
        companyId,
        'removed',
        this.snapshot(existing),
        '',
        actor,
        prisma,
      );
      await this.prices.update(
        {
          where: { id },
          data: { deletedAt: new Date(), updatedBy: actor.userId },
        },
        { prisma },
      );
      await this.audit.record(
        {
          eventType: 'pricing.price.removed',
          companyId,
          ...auditActor(actor),
          resourceType: 'product_price',
          resourceId: id,
          before: this.snapshot(existing),
        },
        { prisma },
      );
    });
    return { id, removed: true };
  }

  /**
   * CD-195 — change the amount of a price from `effectiveFrom`: the current
   * row ends the day before, a new row carries the new amount to the old
   * end. Both saves and their history go in one transaction.
   */
  async revise(
    id: string,
    input: {
      unitPrice?: unknown;
      effectiveFrom?: unknown;
      note?: unknown;
      reason?: unknown;
    },
    actor: Principal,
  ) {
    const companyId = actor.activeCompanyId;
    const existing = await this.require(companyId, id);
    const before = this.snapshot(existing);
    const problems = revisionProblems(before, input.effectiveFrom, today());
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        'วันที่ราคาใหม่มีผลไม่ถูกต้อง — ต้องเป็นวันนี้หรือหลังจากนี้ และอยู่ในช่วงของราคาเดิม',
        problems,
      );
    }
    const effectiveFrom = input.effectiveFrom as string;
    const reason = this.reasonOf(input.reason, true);
    const next = this.clean({
      ...before,
      unitPrice: input.unitPrice,
      validFrom: effectiveFrom,
      note: typeof input.note === 'string' ? input.note : before.note,
    });
    const ended = { ...before, validTo: dayBefore(effectiveFrom) };

    const created = await this.transactions.execute(async (prisma) => {
      await this.prices.update(
        {
          where: { id },
          data: { validTo: day(ended.validTo), updatedBy: actor.userId },
        },
        { prisma },
      );
      await this.writeVersion(
        id,
        companyId,
        'ended',
        ended,
        reason,
        actor,
        prisma,
      );
      await this.assertNoOverlap(companyId, next, id, prisma);
      const row = (await this.prices.create(
        {
          data: {
            companyId,
            productCode: next.productCode,
            priceModel: next.priceModel,
            currency: next.currency,
            unitPrice: next.unitPrice,
            validFrom: day(next.validFrom),
            validTo: next.validTo ? day(next.validTo) : null,
            note: next.note,
            createdBy: actor.userId,
          },
          select: PRICE_SELECT,
        },
        { prisma },
      )) as PriceRow;
      await this.writeVersion(
        row.id,
        companyId,
        'revised',
        next,
        reason,
        actor,
        prisma,
      );
      await this.audit.record(
        {
          eventType: 'pricing.price.revised',
          companyId,
          ...auditActor(actor),
          resourceType: 'product_price',
          resourceId: row.id,
          before: { priceId: id, ...before },
          after: { priceId: row.id, ...next, reason },
        },
        { prisma },
      );
      return row;
    });
    return this.one(companyId, created.id);
  }

  /** CD-195 — every saved state of one price, newest first. */
  async history(id: string, actor: Principal) {
    await this.require(actor.activeCompanyId, id, true);
    const rows = (await this.versions.findMany({
      where: { priceId: id, companyId: actor.activeCompanyId },
      orderBy: { versionNo: 'desc' },
      select: {
        versionNo: true,
        action: true,
        unitPrice: true,
        priceModel: true,
        currency: true,
        validFrom: true,
        validTo: true,
        note: true,
        reason: true,
        changedBy: true,
        changedAt: true,
      },
    })) as {
      versionNo: number;
      action: string;
      unitPrice: unknown;
      priceModel: string;
      currency: string;
      validFrom: Date;
      validTo: Date | null;
      note: string;
      reason: string;
      changedBy: string;
      changedAt: Date;
    }[];
    return rows.map((row) => ({
      ...row,
      unitPrice: Number(row.unitPrice),
      validFrom: dayOf(row.validFrom),
      validTo: dayOf(row.validTo),
    }));
  }

  // --- helpers --------------------------------------------------------------------

  private reasonOf(value: unknown, required: boolean): string {
    const reason = typeof value === 'string' ? value.trim() : '';
    if (reason.length > MAX_REASON) {
      throw new AppError('VALIDATION_FAILED', 'เหตุผลยาวเกินไป', [
        { field: 'reason', reason: 'too_long' },
      ]);
    }
    if (required && !reason) {
      throw new AppError(
        'VALIDATION_FAILED',
        'ต้องระบุเหตุผลเมื่อแก้ราคาที่มีผลแล้ว',
        [{ field: 'reason', reason: 'required' }],
      );
    }
    return reason;
  }

  private async writeVersion(
    priceId: string,
    companyId: string,
    action: 'created' | 'updated' | 'ended' | 'revised' | 'removed',
    value: CleanPrice,
    reason: string,
    actor: Principal,
    prisma: TQueryClient,
  ) {
    const last = (await this.versions.findFirst(
      {
        where: { priceId },
        orderBy: { versionNo: 'desc' },
        select: { versionNo: true },
      },
      { prisma },
    )) as { versionNo: number } | null;
    await this.versions.create(
      {
        data: {
          priceId,
          companyId,
          versionNo: (last?.versionNo ?? 0) + 1,
          action,
          unitPrice: value.unitPrice,
          priceModel: value.priceModel,
          currency: value.currency,
          validFrom: day(value.validFrom),
          validTo: value.validTo ? day(value.validTo) : null,
          note: value.note,
          reason,
          changedBy: actor.userId,
        },
      },
      { prisma },
    );
  }

  private clean(input: PriceInput): CleanPrice {
    const cleaned = cleanPrice(input);
    if (!cleaned.ok) {
      throw new AppError(
        'VALIDATION_FAILED',
        'ข้อมูลราคาไม่ถูกต้อง',
        cleaned.problems,
      );
    }
    return cleaned.value;
  }

  private async assertNoOverlap(
    companyId: string,
    value: CleanPrice,
    selfId: string | null,
    prisma: TQueryClient,
  ) {
    await this.prices.lockSeries(
      `${companyId}:${value.productCode}:${value.currency}`,
      { prisma },
    );
    const siblings = (await this.prices.findMany(
      {
        where: {
          companyId,
          productCode: value.productCode,
          currency: value.currency,
          deletedAt: null,
          ...(selfId ? { id: { not: selfId } } : {}),
        },
        select: PRICE_SELECT,
      },
      { prisma },
    )) as PriceRow[];
    const clash = siblings.find((row) => overlaps(this.rangeOf(row), value));
    if (clash) {
      const range = this.rangeOf(clash);
      throw new AppError(
        'CONFLICT',
        `ช่วงเวลาซ้อนกับราคาที่มีอยู่ ${range.validFrom} – ${range.validTo ?? 'ไม่มีกำหนด'} (${Number(clash.unitPrice).toLocaleString('th-TH')} ${clash.currency})`,
        [{ field: 'valid_from', reason: clash.id }],
      );
    }
  }

  private rangeOf(row: PriceRow) {
    return { validFrom: dayOf(row.validFrom)!, validTo: dayOf(row.validTo) };
  }

  private snapshot(row: PriceRow) {
    return {
      productCode: row.productCode,
      priceModel: row.priceModel as CleanPrice['priceModel'],
      currency: row.currency,
      unitPrice: Number(row.unitPrice),
      ...this.rangeOf(row),
      note: row.note,
    };
  }

  private present(row: PriceRow, names: Map<string, string>, now: string) {
    const range = this.rangeOf(row);
    return {
      id: row.id,
      productCode: row.productCode,
      productName: names.get(row.productCode) ?? null,
      priceModel: row.priceModel,
      currency: row.currency,
      unitPrice: Number(row.unitPrice),
      ...range,
      note: row.note,
      status: priceStatus(range, now),
      updatedAt: row.updatedAt,
    };
  }

  private async namesOf(companyId: string, codes: string[]) {
    const unique = [...new Set(codes)];
    if (!unique.length) return new Map<string, string>();
    const rows = (await this.products.findMany({
      where: { companyId, code: { in: unique } },
      select: { code: true, name: true },
    })) as { code: string; name: string }[];
    return new Map(rows.map((row) => [row.code, row.name]));
  }

  private async require(companyId: string, id: string, withDeleted = false) {
    const row = (await this.prices.findFirst({
      where: { id, companyId, ...(withDeleted ? {} : { deletedAt: null }) },
      select: PRICE_SELECT,
    })) as PriceRow | null;
    // SCOPE-03: another company's price answers 404.
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบราคาที่ระบุ');
    return row;
  }

  private async one(companyId: string, id: string) {
    const row = await this.require(companyId, id);
    const names = await this.namesOf(companyId, [row.productCode]);
    return this.present(row, names, today());
  }
}
