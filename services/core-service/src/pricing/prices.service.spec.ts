import type { Principal } from '@request-management/share';
import { PricesService } from './prices.service';

const pricer = {
  userId: 'pr-1',
  activeCompanyId: 'osd',
  permissions: ['pricing.price.manage'],
} as unknown as Principal;

interface Row {
  id: string;
  companyId: string;
  productCode: string;
  priceModel: string;
  scope: string;
  customerId: string | null;
  segmentValueId: string | null;
  opportunityId: string | null;
  currency: string;
  unitPrice: number;
  validFrom: Date;
  validTo: Date | null;
  note: string;
  createdBy: string;
  updatedAt: Date;
  updatedBy: string | null;
  deletedAt: Date | null;
}

const d = (value: string) => new Date(`${value}T00:00:00Z`);

function harness(
  seed: Partial<Row>[] = [],
  options: {
    deal?: { id: string; customerId: string | null } | null;
    segments?: { valueId: string }[];
  } = {},
) {
  const rows: Row[] = seed.map((row, index) => ({
    id: `p-${index + 1}`,
    companyId: 'osd',
    productCode: 'SIP-TRUNK',
    priceModel: 'unit',
    scope: 'standard',
    customerId: null,
    segmentValueId: null,
    opportunityId: null,
    currency: 'THB',
    unitPrice: 1000,
    validFrom: d('2026-01-01'),
    validTo: null,
    note: '',
    createdBy: 'x',
    updatedAt: new Date(),
    updatedBy: null,
    deletedAt: null,
    ...row,
  }));
  const matches = (row: Row, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([key, value]) => {
      const field = (row as unknown as Record<string, unknown>)[key];
      if (['validFrom', 'validTo'].includes(key)) return true;
      if (key === 'AND') {
        return (value as Record<string, unknown>[]).every((part) =>
          matches(row, part),
        );
      }
      if (key === 'OR') {
        const clauses = value as Record<string, unknown>[];
        // The date clause (validTo) is not modelled — treat it as a pass.
        if (clauses.some((clause) => 'validTo' in clause)) return true;
        return clauses.some((clause) => matches(row, clause));
      }
      if (value && typeof value === 'object') {
        if ('not' in value) return field !== value.not;
        if ('in' in value) {
          return (value as { in: unknown[] }).in.includes(field);
        }
      }
      return field === value;
    });
  const prices = {
    findMany: jest.fn(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve(rows.filter((row) => matches(row, where))),
    ),
    findFirst: jest.fn(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve(rows.find((row) => matches(row, where)) ?? null),
    ),
    create: jest.fn(({ data }: { data: Partial<Row> }) => {
      const row = {
        id: `p-new-${rows.length}`,
        companyId: 'osd',
        note: '',
        createdBy: 'x',
        updatedAt: new Date(),
        updatedBy: null,
        deletedAt: null,
        ...data,
      } as Row;
      rows.push(row);
      return Promise.resolve(row);
    }),
    update: jest.fn(() => Promise.resolve({})),
    lockSeries: jest.fn(() => Promise.resolve()),
  };
  const products = {
    findMany: jest.fn(() =>
      Promise.resolve([{ code: 'SIP-TRUNK', name: 'SIP Trunk' }]),
    ),
  };
  const catalog = { assertCodes: jest.fn(() => Promise.resolve()) };
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const transactions = {
    execute: jest.fn((fn: (prisma: unknown) => Promise<unknown>) => fn({})),
  };
  const versions = {
    findFirst: jest.fn(() => Promise.resolve(null)),
    findMany: jest.fn(() => Promise.resolve([])),
    create: jest.fn(() => Promise.resolve({})),
  };
  // CD-197 — who a special price is for.
  const customers = {
    findFirst: jest.fn(({ where }: { where: { id: string } }) =>
      Promise.resolve(where.id === 'c-1' ? { id: 'c-1' } : null),
    ),
    findMany: jest.fn(() =>
      Promise.resolve([
        { id: 'c-1', customerCode: 'CUS-1', nameTh: 'ลูกค้า ก' },
      ]),
    ),
  };
  const opportunities = {
    findFirst: jest.fn(() =>
      Promise.resolve(options.deal === undefined ? null : options.deal),
    ),
    findMany: jest.fn(() => Promise.resolve([])),
  };
  const segmentValues = {
    findFirst: jest.fn(() => Promise.resolve(null)),
    findMany: jest.fn(() => Promise.resolve([])),
  };
  const segmentAssignments = {
    findMany: jest.fn(() => Promise.resolve(options.segments ?? [])),
  };
  const service = new PricesService(
    prices as never,
    versions as never,
    products as never,
    customers as never,
    opportunities as never,
    segmentValues as never,
    segmentAssignments as never,
    catalog as never,
    audit as never,
    transactions as never,
  );
  return { service, prices, versions, catalog, audit, rows };
}

describe('PricesService (CD-194)', () => {
  it('adds a price for a known code, audited, after locking the series', async () => {
    const { service, prices, catalog, audit } = harness();
    const created = await service.create(
      {
        productCode: 'SIP-TRUNK',
        unitPrice: 1500,
        validFrom: '2026-10-01',
      },
      pricer,
    );
    expect(catalog.assertCodes).toHaveBeenCalledWith('osd', [
      { code: 'SIP-TRUNK', field: 'product_code' },
    ]);
    expect(prices.lockSeries).toHaveBeenCalledWith(
      'osd:SIP-TRUNK:THB:standard:',
      {
        prisma: {},
      },
    );
    expect(created).toMatchObject({
      productCode: 'SIP-TRUNK',
      productName: 'SIP Trunk',
      unitPrice: 1500,
      validFrom: '2026-10-01',
      validTo: null,
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'pricing.price.created' }),
      { prisma: {} },
    );
  });

  it('refuses a range that overlaps the same code and currency', async () => {
    const { service, prices } = harness([
      { validFrom: d('2026-01-01'), validTo: d('2026-12-31') },
    ]);
    await expect(
      service.create(
        { productCode: 'SIP-TRUNK', unitPrice: 1, validFrom: '2026-12-31' },
        pricer,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(prices.create).not.toHaveBeenCalled();

    // Another currency, or the day after, is fine.
    await service.create(
      {
        productCode: 'SIP-TRUNK',
        currency: 'USD',
        unitPrice: 30,
        validFrom: '2026-06-01',
      },
      pricer,
    );
    await service.create(
      { productCode: 'SIP-TRUNK', unitPrice: 1100, validFrom: '2027-01-01' },
      pricer,
    );
    expect(prices.create).toHaveBeenCalledTimes(2);
  });

  it('an update of a future price may keep its own range', async () => {
    const { service, prices } = harness([
      { validFrom: d('2099-01-01'), validTo: d('2099-12-31') },
    ]);
    await service.update('p-1', { unitPrice: 1200 }, pricer);
    expect(prices.update).toHaveBeenCalledWith(
      {
        where: { id: 'p-1' },
        data: expect.objectContaining({ unitPrice: 1200 }) as unknown,
      },
      { prisma: {} },
    );
  });

  it('rejects invalid input with every problem', async () => {
    const { service } = harness();
    await expect(
      service.create(
        { productCode: '', unitPrice: -5, validFrom: 'soon' },
        pricer,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('answers 404 for a price of another company (SCOPE-03)', async () => {
    const { service } = harness([{ companyId: 'other' }]);
    await expect(service.remove('p-1', pricer)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('lookup returns the price in effect on the day, per code', async () => {
    const { service } = harness([
      { validFrom: d('2026-01-01'), validTo: d('2026-09-30'), unitPrice: 900 },
      { validFrom: d('2026-10-01'), validTo: null, unitPrice: 1000 },
    ]);
    const result = await service.lookup(
      pricer,
      ['SIP-TRUNK', 'NONE'],
      'thb',
      '2026-10-15',
    );
    expect(result).toEqual({
      'SIP-TRUNK': expect.objectContaining({
        price_id: 'p-2',
        unit_price: 1000,
        valid_from: '2026-10-01',
      }) as unknown,
    });
  });

  describe('CD-195 versions', () => {
    const started = () =>
      harness([{ validFrom: d('2020-01-01'), validTo: null, unitPrice: 1000 }]);

    it('writes version 1 when a price is created', async () => {
      const { service, versions } = harness();
      await service.create(
        { productCode: 'SIP-TRUNK', unitPrice: 1, validFrom: '2099-01-01' },
        pricer,
      );
      expect(versions.create).toHaveBeenCalledWith(
        {
          data: expect.objectContaining({
            versionNo: 1,
            action: 'created',
          }) as unknown,
        },
        { prisma: {} },
      );
    });

    it('a started price refuses a new amount but may end, with a reason', async () => {
      const { service, prices, versions } = started();
      await expect(
        service.update('p-1', { unitPrice: 1100, reason: 'x' }, pricer),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(
        service.update('p-1', { validTo: '2099-12-31' }, pricer),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

      await service.update(
        'p-1',
        { validTo: '2099-12-31', reason: 'เลิกขายรุ่นนี้' },
        pricer,
      );
      expect(prices.update).toHaveBeenCalled();
      expect(versions.create).toHaveBeenCalledWith(
        {
          data: expect.objectContaining({
            action: 'ended',
            reason: 'เลิกขายรุ่นนี้',
          }) as unknown,
        },
        { prisma: {} },
      );
    });

    it('a started price cannot be deleted', async () => {
      const { service } = started();
      await expect(service.remove('p-1', pricer)).rejects.toMatchObject({
        code: 'CONFLICT',
      });
    });

    it('revise ends the old row the day before and carries on with a new one', async () => {
      const { service, prices, versions } = started();
      await service.revise(
        'p-1',
        { unitPrice: 1100, effectiveFrom: '2099-01-01', reason: 'ต้นทุนขึ้น' },
        pricer,
      );
      expect(prices.update).toHaveBeenCalledWith(
        {
          where: { id: 'p-1' },
          data: expect.objectContaining({
            validTo: d('2098-12-31'),
          }) as unknown,
        },
        { prisma: {} },
      );
      expect(prices.create).toHaveBeenCalledWith(
        {
          data: expect.objectContaining({
            unitPrice: 1100,
            validFrom: d('2099-01-01'),
            validTo: null,
          }) as unknown,
          select: expect.anything() as unknown,
        },
        { prisma: {} },
      );
      expect(
        versions.create.mock.calls.map(
          (call) =>
            (call as unknown as [{ data: { action: string } }])[0].data.action,
        ),
      ).toEqual(['ended', 'revised']);
    });

    it('revise refuses a date in the past or without a reason', async () => {
      const { service } = started();
      await expect(
        service.revise(
          'p-1',
          { unitPrice: 1, effectiveFrom: '2020-06-01', reason: 'x' },
          pricer,
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(
        service.revise(
          'p-1',
          { unitPrice: 1, effectiveFrom: '2099-01-01' },
          pricer,
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });
  });

  describe('CD-197 special prices', () => {
    it('a special price needs a target of the company and an end date', async () => {
      const { service, prices } = harness();
      await expect(
        service.create(
          {
            scope: 'customer',
            targetId: 'c-1',
            productCode: 'SIP-TRUNK',
            unitPrice: 900,
            validFrom: '2099-01-01',
          },
          pricer,
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(
        service.create(
          {
            scope: 'customer',
            targetId: 'other-company',
            productCode: 'SIP-TRUNK',
            unitPrice: 900,
            validFrom: '2099-01-01',
            validTo: '2099-12-31',
          },
          pricer,
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await service.create(
        {
          scope: 'customer',
          targetId: 'c-1',
          productCode: 'SIP-TRUNK',
          unitPrice: 900,
          validFrom: '2099-01-01',
          validTo: '2099-12-31',
        },
        pricer,
      );
      expect(prices.create).toHaveBeenCalledWith(
        {
          data: expect.objectContaining({
            scope: 'customer',
            customerId: 'c-1',
            segmentValueId: null,
            opportunityId: null,
          }) as unknown,
          select: expect.anything() as unknown,
        },
        { prisma: {} },
      );
    });

    it('a customer price does not collide with the standard price of the same range', async () => {
      const { service, prices } = harness([
        { validFrom: d('2099-01-01'), validTo: d('2099-12-31') },
      ]);
      await service.create(
        {
          scope: 'customer',
          targetId: 'c-1',
          productCode: 'SIP-TRUNK',
          unitPrice: 900,
          validFrom: '2099-01-01',
          validTo: '2099-12-31',
        },
        pricer,
      );
      expect(prices.create).toHaveBeenCalled();
    });

    it('lookup with a deal picks deal > customer > group > standard', async () => {
      const seed: Partial<Row>[] = [
        { unitPrice: 1000 },
        {
          scope: 'segment',
          segmentValueId: 'seg-1',
          unitPrice: 950,
          validTo: d('2099-12-31'),
        },
        {
          scope: 'customer',
          customerId: 'c-1',
          unitPrice: 920,
          validTo: d('2099-12-31'),
        },
        {
          scope: 'customer',
          customerId: 'c-2',
          unitPrice: 100,
          validTo: d('2099-12-31'),
        },
      ];
      const withCustomer = harness(seed, {
        deal: { id: 'opp-1', customerId: 'c-1' },
        segments: [{ valueId: 'seg-1' }],
      });
      expect(
        (
          await withCustomer.service.lookup(
            pricer,
            ['SIP-TRUNK'],
            'THB',
            '2026-10-01',
            'opp-1',
          )
        )['SIP-TRUNK'],
      ).toMatchObject({ unit_price: 920, scope: 'customer' });

      // No deal (or one out of reach) = standard prices only.
      const noDeal = harness(seed);
      expect(
        (
          await noDeal.service.lookup(
            pricer,
            ['SIP-TRUNK'],
            'THB',
            '2026-10-01',
            'opp-x',
          )
        )['SIP-TRUNK'],
      ).toMatchObject({ unit_price: 1000, scope: 'standard' });
    });
  });
});
