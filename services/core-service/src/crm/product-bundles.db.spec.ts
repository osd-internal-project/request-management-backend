import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import {
  AuditWriter,
  PrismaTransactionService,
  type Principal,
} from '@request-management/share';
import { ProductBundlesService } from './product-bundles.service';
import { ProductBundleRepository } from './product.repositories';

/**
 * ชุดรายการของ product — the queries the unit spec mocks, against a real
 * engine: the nested create, replacing the items in one update, the ordered
 * item select, and the soft delete. Writes one bundle and removes it.
 * Needs a migrated database with a company; skipped otherwise:
 *
 *   CORE_DB_TEST_URL=postgresql://… yarn workspace \
 *     @request-management/core-service test product-bundles.db
 */
const DB_URL = process.env.CORE_DB_TEST_URL;

(DB_URL ? describe : describe.skip)('product bundles (real Postgres)', () => {
  let prisma: PrismaClient;
  let actor: Principal;
  let service: ProductBundlesService;
  const name = `TEST bundle ${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    const company = await prisma.company.findFirstOrThrow({
      select: { id: true },
    });
    actor = {
      userId: 'svc-test',
      activeCompanyId: company.id,
      isServiceAccount: true,
      permissions: ['pricing.price.manage'],
    } as unknown as Principal;
    service = new ProductBundlesService(
      new ProductBundleRepository(prisma as never),
      { assertKnownCodes: () => Promise.resolve() } as never,
      {
        standardPricesFor: () =>
          Promise.resolve({ products: new Map(), priceOf: new Map() }),
      } as never,
      new AuditWriter(prisma as never),
      new PrismaTransactionService(prisma as never),
    );
  });

  afterAll(async () => {
    await prisma.productBundle.deleteMany({ where: { name } });
    await prisma.$disconnect();
  });

  it('creates, matches, replaces the items, feeds a Lead, and soft-deletes', async () => {
    const created = await service.create(
      {
        name,
        items: [
          { productCode: 'T-MAIN', quantity: 2, termMonths: 12 },
          { productCode: 'T-EXTRA', quantity: 1, optional: true },
        ],
      },
      actor,
    );
    expect(created.items.map((item) => item.productCode)).toEqual([
      'T-MAIN',
      'T-EXTRA',
    ]);

    const matched = await service.match(actor, name.toUpperCase());
    expect(matched.bundle?.id).toBe(created.id);

    const updated = await service.update(
      created.id,
      { items: [{ productCode: 'T-OTHER', quantity: 3 }] },
      actor,
    );
    expect(updated.items).toEqual([
      expect.objectContaining({ productCode: 'T-OTHER', quantity: 3 }),
    ]);

    expect(
      await service.itemsForLead(actor.activeCompanyId, {
        subProduct: null,
        intakeData: { selected_product: name },
      }),
    ).toEqual({
      source: 'bundle',
      product: name,
      items: [{ product_code: 'T-OTHER', quantity: 3 }],
    });

    await service.remove(created.id, actor);
    expect((await service.match(actor, name)).bundle).toBeNull();
    expect((await service.list(actor)).some((row) => row.name === name)).toBe(
      false,
    );
  });
});
