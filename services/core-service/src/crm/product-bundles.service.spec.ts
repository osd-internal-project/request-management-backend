import type { Principal } from '@request-management/share';
import { ProductBundlesService } from './product-bundles.service';

const actor = {
  userId: 'user-1',
  activeCompanyId: 'company-1',
  permissions: ['pricing.price.manage'],
} as unknown as Principal;

const BUNDLE = {
  id: 'bundle-1',
  name: 'D-DEBT',
  note: '',
  active: true,
  updatedAt: new Date('2026-11-12T00:00:00Z'),
  items: [
    {
      lineNo: 1,
      productCode: 'DD-LICENSE',
      quantity: 2,
      termMonths: 12,
      optional: false,
    },
    {
      lineNo: 2,
      productCode: 'DD-TRAINING',
      quantity: 1,
      termMonths: null,
      optional: true,
    },
  ],
};

function harness(rows: object[] = [BUNDLE]) {
  const bundles = {
    findMany: jest.fn(() => Promise.resolve(rows)),
    findFirst: jest.fn((args: { where: { id: string; companyId: string } }) =>
      Promise.resolve(
        args.where.companyId === 'company-1'
          ? ((rows as { id: string }[]).find(
              (row) => row.id === args.where.id,
            ) ?? null)
          : null,
      ),
    ),
    create: jest.fn((args: { data: { name: string } }) =>
      Promise.resolve({ ...BUNDLE, id: 'bundle-new', name: args.data.name }),
    ),
    update: jest.fn(() => Promise.resolve(BUNDLE)),
  };
  const catalog = { assertKnownCodes: jest.fn(() => Promise.resolve()) };
  const quotations = {
    standardPricesFor: jest.fn((_company: string, codes: string[]) =>
      Promise.resolve({
        products: new Map(
          codes.map((code) => [code, { name: `ชื่อ ${code}`, unit: 'ชุด' }]),
        ),
        priceOf: new Map(
          codes
            .filter((code) => code === 'DD-LICENSE')
            .map((code) => [
              code,
              { unitPrice: { toString: () => '3500' }, priceModel: 'monthly' },
            ]),
        ),
      }),
    ),
  };
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const transactions = {
    execute: jest.fn((work: (prisma: object) => Promise<unknown>) => work({})),
  };
  const service = new ProductBundlesService(
    bundles as never,
    catalog as never,
    quotations as never,
    audit as never,
    transactions as never,
  );
  return { service, bundles, catalog, audit };
}

describe('ProductBundlesService — ชุดรายการของ product (12 พ.ย. 2569)', () => {
  it('lists each item with its name and the standard price in effect', async () => {
    const [view] = await harness().service.list(actor);
    expect(view.items).toEqual([
      expect.objectContaining({
        productCode: 'DD-LICENSE',
        productName: 'ชื่อ DD-LICENSE',
        quantity: 2,
        optional: false,
        unitPrice: 3500,
        priceModel: 'monthly',
      }),
      expect.objectContaining({
        productCode: 'DD-TRAINING',
        optional: true,
        unitPrice: null,
      }),
    ]);
  });

  it('matches a product name without case, and answers null for none', async () => {
    const { service } = harness();
    expect((await service.match(actor, ' d-debt ')).bundle?.id).toBe(
      'bundle-1',
    );
    expect((await service.match(actor, 'IP-PHONE')).bundle).toBeNull();
  });

  it('creates with numbered lines and an audit entry in the transaction', async () => {
    const { service, bundles, audit, catalog } = harness([]);
    await service.create(
      {
        name: 'IP Phone',
        items: [
          { productCode: 'IP-PHONE', quantity: 5 },
          { productCode: 'HEADSET', quantity: 5, optional: true },
        ],
      },
      actor,
    );
    expect(catalog.assertKnownCodes).toHaveBeenCalledWith('company-1', [
      { product_code: 'IP-PHONE' },
      { product_code: 'HEADSET' },
    ]);
    const data = (
      bundles.create.mock.calls[0] as unknown as [
        { data: { companyId: string; items: { create: object[] } } },
      ]
    )[0].data;
    expect(data.companyId).toBe('company-1');
    expect(data.items.create).toEqual([
      expect.objectContaining({ lineNo: 1, productCode: 'IP-PHONE' }),
      expect.objectContaining({ lineNo: 2, optional: true }),
    ]);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'pricing.product_bundle.created',
      }),
      expect.anything(),
    );
  });

  it('refuses a second bundle for the same product (409)', async () => {
    const { service, bundles } = harness();
    await expect(
      service.create(
        { name: 'd-debt', items: [{ productCode: 'X', quantity: 1 }] },
        actor,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(bundles.create).not.toHaveBeenCalled();
  });

  it('refuses an invalid bundle before anything is written (400)', async () => {
    const { service, bundles } = harness([]);
    await expect(
      service.create({ name: 'X', items: [] }, actor),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(bundles.create).not.toHaveBeenCalled();
  });

  it("SCOPE-03: another company's bundle answers 404 on update and remove", async () => {
    const { service, bundles } = harness();
    const other = { ...actor, activeCompanyId: 'company-2' } as Principal;
    await expect(
      service.update('bundle-1', { note: 'x' }, other),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(service.remove('bundle-1', other)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(bundles.update).not.toHaveBeenCalled();
  });

  it('update keeps the items when none are sent, and soft-deletes on remove', async () => {
    const { service, bundles } = harness();
    await service.update('bundle-1', { active: false }, actor);
    const updated = (
      bundles.update.mock.calls[0] as unknown as [{ data: object }]
    )[0].data;
    expect(updated).toMatchObject({ active: false, name: 'D-DEBT' });
    expect(updated).not.toHaveProperty('items');

    await service.remove('bundle-1', actor);
    const removed = (
      bundles.update.mock.calls[1] as unknown as [{ data: object }]
    )[0].data;
    expect(removed).toHaveProperty('deletedAt');
  });

  describe('itemsForLead', () => {
    it("the Lead's own list wins over the bundle", async () => {
      const out = await harness().service.itemsForLead('company-1', {
        subProduct: null,
        intakeData: {
          selected_product: 'D-DEBT',
          products: [{ product_code: 'DD-LICENSE', quantity: 9 }],
        },
      });
      expect(out).toEqual({
        source: 'lead',
        product: 'D-DEBT',
        items: [{ product_code: 'DD-LICENSE', quantity: 9 }],
      });
    });

    it('else the mandatory items of the bundle of the picked product', async () => {
      const out = await harness().service.itemsForLead('company-1', {
        subProduct: 'IP-PHONE',
        intakeData: { selected_product: 'd-debt' },
      });
      expect(out).toEqual({
        source: 'bundle',
        product: 'D-DEBT',
        requirements: [],
        items: [{ product_code: 'DD-LICENSE', quantity: 2, term_months: 12 }],
      });
    });

    it('the bundle picked on the Lead wins over the product name', async () => {
      const out = await harness().service.itemsForLead('company-1', {
        subProduct: 'Dcallcenter',
        intakeData: { selected_product: 'ATOM', selected_bundle: ' d-debt ' },
      });
      expect(out).toMatchObject({ source: 'bundle', product: 'D-DEBT' });
    });

    it('says which bundle name it did not find', async () => {
      const out = await harness().service.itemsForLead('company-1', {
        subProduct: 'Dcallcenter',
        intakeData: { selected_product: 'ATOM' },
      });
      expect(out).toEqual({
        source: 'sub_product',
        product: 'ATOM',
        bundle_not_found: 'ATOM',
        items: [{ product_code: 'Dcallcenter', quantity: 1 }],
      });
    });

    it('else Sub Product as one item code, else nothing', async () => {
      const { service } = harness();
      expect(
        await service.itemsForLead('company-1', {
          subProduct: ' IP-PHONE ',
          intakeData: null,
        }),
      ).toEqual({
        source: 'sub_product',
        product: 'IP-PHONE',
        bundle_not_found: 'IP-PHONE',
        items: [{ product_code: 'IP-PHONE', quantity: 1 }],
      });
      expect(await service.itemsForLead('company-1', null)).toEqual({
        source: 'none',
        product: null,
        items: [],
      });
    });
  });
});
