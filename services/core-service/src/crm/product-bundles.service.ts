import { Injectable } from '@nestjs/common';
import {
  AppError,
  AuditWriter,
  auditActor,
  Principal,
  PrismaTransactionService,
} from '@request-management/share';
import { ProductCatalogService } from './product-catalog.service';
import { ProductBundleRepository } from './product.repositories';
import { QuotationsService } from './quotations.service';
import {
  bundleKey,
  bundleNameOfLead,
  cleanBundle,
  listedItemsOfLead,
  mandatoryItems,
  productNameOfLead,
  type BundleInput,
  type BundleItemState,
  type CleanBundle,
  type QuotationItem,
} from './product-bundle-rules';

interface BundleRow {
  id: string;
  name: string;
  note: string;
  active: boolean;
  updatedAt: Date;
  items: {
    lineNo: number;
    productCode: string;
    quantity: unknown;
    termMonths: number | null;
    optional: boolean;
  }[];
}

const BUNDLE_SELECT = {
  id: true,
  name: true,
  note: true,
  active: true,
  updatedAt: true,
  items: {
    select: {
      lineNo: true,
      productCode: true,
      quantity: true,
      termMonths: true,
      optional: true,
    },
    orderBy: { lineNo: 'asc' },
  },
} as const;

/** Where a Lead's quotation items came from — shown on the checklist. */
export type LeadItemsSource = 'lead' | 'bundle' | 'sub_product' | 'none';

export interface LeadItems {
  source: LeadItemsSource;
  /** The product looked up, when there was one to look up. */
  product: string | null;
  /**
   * The name a bundle was looked up by and not found — the checklist says so
   * instead of blaming the price list (13 พ.ย. 2569).
   */
  bundle_not_found?: string;
  items: QuotationItem[];
}

/**
 * ชุดรายการของ product (12 พ.ย. 2569, user decision) — which SAP items a
 * quotation for a product carries. Kept on its own screen by Pricing; read by
 * the sales automation and by the Lead screen, where the salesperson adjusts
 * the list for one Lead (that writes `intake_data.products`, which wins).
 */
@Injectable()
export class ProductBundlesService {
  constructor(
    private readonly bundles: ProductBundleRepository,
    private readonly catalog: ProductCatalogService,
    private readonly quotations: QuotationsService,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  async list(actor: Principal) {
    const rows = await this.rows(actor.activeCompanyId, true);
    return this.views(actor.activeCompanyId, rows);
  }

  /** The bundle in use for a product name — null when none is set up. */
  async match(actor: Principal, name: string) {
    const row = await this.byName(actor.activeCompanyId, name);
    if (!row) return { bundle: null };
    const [bundle] = await this.views(actor.activeCompanyId, [row]);
    return { bundle };
  }

  /** The bundles a salesperson can pick for a Lead — active ones, by name. */
  async options(actor: Principal) {
    const rows = await this.rows(actor.activeCompanyId, false);
    return { names: rows.map((row) => row.name) };
  }

  async create(input: BundleInput, actor: Principal) {
    const value = await this.clean(actor.activeCompanyId, input, null);
    const created = await this.transactions.execute(async (prisma) => {
      const row = (await this.bundles.create(
        {
          data: {
            companyId: actor.activeCompanyId,
            name: value.name,
            note: value.note,
            active: value.active,
            createdBy: actor.userId,
            items: { create: itemRows(value.items) },
          },
          select: BUNDLE_SELECT,
        },
        { prisma },
      )) as unknown as BundleRow;
      await this.audit.record(
        {
          eventType: 'pricing.product_bundle.created',
          companyId: actor.activeCompanyId,
          ...auditActor(actor),
          resourceType: 'product_bundle',
          resourceId: row.id,
          after: { ...value },
        },
        { prisma },
      );
      return row;
    });
    return (await this.views(actor.activeCompanyId, [created]))[0];
  }

  /** Items given replace the whole list; left out, the list stays. */
  async update(id: string, input: BundleInput, actor: Principal) {
    const existing = await this.require(actor.activeCompanyId, id);
    const before = stateOf(existing);
    const value = await this.clean(
      actor.activeCompanyId,
      {
        name: input.name ?? before.name,
        note: input.note ?? before.note,
        active: input.active ?? before.active,
        items: input.items ?? before.items,
      },
      id,
    );
    const updated = await this.transactions.execute(async (prisma) => {
      const row = (await this.bundles.update(
        {
          where: { id },
          data: {
            name: value.name,
            note: value.note,
            active: value.active,
            updatedBy: actor.userId,
            ...(input.items !== undefined
              ? { items: { deleteMany: {}, create: itemRows(value.items) } }
              : {}),
          },
          select: BUNDLE_SELECT,
        },
        { prisma },
      )) as unknown as BundleRow;
      await this.audit.record(
        {
          eventType: 'pricing.product_bundle.updated',
          companyId: actor.activeCompanyId,
          ...auditActor(actor),
          resourceType: 'product_bundle',
          resourceId: id,
          before: { ...before },
          after: { ...value },
        },
        { prisma },
      );
      return row;
    });
    return (await this.views(actor.activeCompanyId, [updated]))[0];
  }

  /** Soft delete — a quotation already drafted keeps its lines. */
  async remove(id: string, actor: Principal) {
    await this.require(actor.activeCompanyId, id);
    await this.transactions.execute(async (prisma) => {
      await this.bundles.update(
        {
          where: { id },
          data: { deletedAt: new Date(), updatedBy: actor.userId },
        },
        { prisma },
      );
      await this.audit.record(
        {
          eventType: 'pricing.product_bundle.removed',
          companyId: actor.activeCompanyId,
          ...auditActor(actor),
          resourceType: 'product_bundle',
          resourceId: id,
        },
        { prisma },
      );
    });
    return { id, removed: true };
  }

  /**
   * What a quotation for this Lead carries, in the order asked:
   * the Lead's own list (`intake_data.products`); else the mandatory items of
   * the bundle picked on the Lead (`intake_data.selected_bundle`), else of
   * the bundle named after its product; else its Sub Product read as one
   * item code.
   */
  async itemsForLead(
    companyId: string,
    lead: { subProduct: string | null; intakeData: unknown } | null,
  ): Promise<LeadItems> {
    const product = productNameOfLead(lead);
    const listed = listedItemsOfLead(lead);
    if (listed.length) return { source: 'lead', product, items: listed };
    const names = [bundleNameOfLead(lead), product].filter(
      (name): name is string => !!name,
    );
    if (names.length) {
      const rows = await this.rows(companyId, false);
      for (const name of names) {
        const bundle = rows.find(
          (row) => bundleKey(row.name) === bundleKey(name),
        );
        if (bundle) {
          return {
            source: 'bundle',
            product: bundle.name,
            items: mandatoryItems(stateOf(bundle).items),
          };
        }
      }
    }
    const code = lead?.subProduct?.trim();
    const missed = names.length ? { bundle_not_found: names[0] } : {};
    return code
      ? {
          source: 'sub_product',
          product,
          ...missed,
          items: [{ product_code: code, quantity: 1 }],
        }
      : { source: 'none', product, ...missed, items: [] };
  }

  // --- helpers ---------------------------------------------------------------

  private async rows(companyId: string, includeInactive: boolean) {
    return (await this.bundles.findMany({
      where: {
        companyId,
        deletedAt: null,
        ...(includeInactive ? {} : { active: true }),
      },
      select: BUNDLE_SELECT,
      orderBy: { name: 'asc' },
    })) as unknown as BundleRow[];
  }

  private async byName(companyId: string, name: string) {
    const key = bundleKey(name);
    if (!key) return null;
    const rows = await this.rows(companyId, false);
    return rows.find((row) => bundleKey(row.name) === key) ?? null;
  }

  private async require(companyId: string, id: string) {
    const row = (await this.bundles.findFirst({
      where: { id, companyId, deletedAt: null },
      select: BUNDLE_SELECT,
    })) as unknown as BundleRow | null;
    // SCOPE-03: another company's bundle answers 404.
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบชุดรายการที่ระบุ');
    return row;
  }

  private async clean(
    companyId: string,
    input: BundleInput,
    selfId: string | null,
  ): Promise<CleanBundle> {
    const cleaned = cleanBundle(input);
    if (!cleaned.ok) {
      throw new AppError(
        'VALIDATION_FAILED',
        'ชุดรายการไม่ถูกต้อง',
        cleaned.problems,
      );
    }
    const value = cleaned.value;
    const key = bundleKey(value.name);
    const taken = (await this.rows(companyId, true)).some(
      (row) => row.id !== selfId && bundleKey(row.name) === key,
    );
    if (taken) {
      throw new AppError(
        'CONFLICT',
        `มีชุดรายการของ ${value.name} อยู่แล้ว — แก้ชุดเดิมแทนการเพิ่มใหม่`,
        [{ field: 'name', reason: 'duplicate' }],
      );
    }
    await this.catalog.assertKnownCodes(
      companyId,
      value.items.map((item) => ({ product_code: item.productCode })),
    );
    return value;
  }

  /** Each item with its catalog name and the standard price in effect today. */
  private async views(companyId: string, rows: readonly BundleRow[]) {
    const codes = [
      ...new Set(rows.flatMap((row) => row.items.map((i) => i.productCode))),
    ];
    const { products, priceOf } = await this.quotations.standardPricesFor(
      companyId,
      codes,
      'THB',
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      note: row.note,
      active: row.active,
      updatedAt: row.updatedAt,
      items: row.items.map((item) => {
        const product = products.get(item.productCode);
        const price = priceOf.get(item.productCode);
        return {
          productCode: item.productCode,
          productName: product?.name ?? null,
          unit: product?.unit ?? null,
          quantity: Number(item.quantity),
          termMonths: item.termMonths,
          optional: item.optional,
          /** null = no standard price in effect: the automation stops there. */
          unitPrice: price ? Number(price.unitPrice) : null,
          priceModel: price?.priceModel ?? null,
        };
      }),
    }));
  }
}

const stateOf = (row: BundleRow) => ({
  name: row.name,
  note: row.note,
  active: row.active,
  items: row.items.map((item): BundleItemState => ({
    productCode: item.productCode,
    quantity: Number(item.quantity),
    termMonths: item.termMonths,
    optional: item.optional,
  })),
});

const itemRows = (items: readonly BundleItemState[]) =>
  items.map((item, index) => ({
    lineNo: index + 1,
    productCode: item.productCode,
    quantity: item.quantity,
    termMonths: item.termMonths,
    optional: item.optional,
  }));
