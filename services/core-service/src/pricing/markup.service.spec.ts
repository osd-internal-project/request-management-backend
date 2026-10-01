import type { Principal } from '@request-management/share';
import { MarkupService } from './markup.service';

const pricer = {
  userId: 'pr-1',
  activeCompanyId: 'osd',
  permissions: ['pricing.price.manage'],
  ledUnitIds: [],
  scopedUnitIds: [],
} as unknown as Principal;

function harness(options: { segmentFound?: boolean } = {}) {
  const rules = {
    findMany: jest.fn(() =>
      Promise.resolve([
        {
          id: 'r-all',
          priority: 100,
          workType: null,
          productGroupCode: null,
          segmentValueId: null,
          markupPct: 20,
          active: true,
        },
        {
          id: 'r-voice',
          priority: 100,
          workType: null,
          productGroupCode: '101',
          segmentValueId: null,
          markupPct: 12,
          active: true,
        },
        {
          id: 'r-vip',
          priority: 10,
          workType: null,
          productGroupCode: null,
          segmentValueId: 'seg-vip',
          markupPct: 8,
          active: true,
        },
      ]),
    ),
    create: jest.fn(() => Promise.resolve({ id: 'r-new', markupPct: 15 })),
  };
  const products = {
    findMany: jest.fn(() =>
      Promise.resolve([{ code: 'SIP-TRUNK', groupCode: '101' }]),
    ),
  };
  const opportunities = {
    findFirst: jest.fn(() => Promise.resolve({ customerId: 'c-1' })),
  };
  const segmentValues = {
    findFirst: jest.fn(() =>
      Promise.resolve(
        options.segmentFound === false ? null : { id: 'seg-vip' },
      ),
    ),
  };
  const segmentAssignments = {
    findMany: jest.fn(() => Promise.resolve([{ valueId: 'seg-vip' }])),
  };
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const transactions = {
    execute: jest.fn((fn: (prisma: unknown) => Promise<unknown>) => fn({})),
  };
  const service = new MarkupService(
    rules as never,
    products as never,
    opportunities as never,
    segmentValues as never,
    segmentAssignments as never,
    audit as never,
    transactions as never,
  );
  return { service, rules, audit };
}

describe('MarkupService (CD-200)', () => {
  it('suggest picks per line by SAP group and the deal customer’s groups', async () => {
    const { service } = harness();
    expect(
      await service.suggest(pricer, [
        { productCode: 'SIP-TRUNK', workType: 'equipment' },
        { productCode: 'INSTALL', workType: 'service' },
      ]),
    ).toEqual([
      { rule_id: 'r-voice', markup_pct: 12 },
      { rule_id: 'r-all', markup_pct: 20 },
    ]);
    // With the deal, its VIP customer group outranks both.
    expect(
      await service.suggest(
        pricer,
        [{ productCode: 'SIP-TRUNK', workType: 'equipment' }],
        'opp-1',
      ),
    ).toEqual([{ rule_id: 'r-vip', markup_pct: 8 }]);
  });

  it('create validates, checks the customer group is the company’s, and audits', async () => {
    const missing = harness({ segmentFound: false });
    await expect(
      missing.service.create(
        { markupPct: 10, segmentValueId: 'seg-x' },
        pricer,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      missing.service.create({ markupPct: -5 }, pricer),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    const { service, rules, audit } = harness();
    await service.create({ markupPct: 15, workType: 'equipment' }, pricer);
    expect(rules.create).toHaveBeenCalledWith(
      {
        data: expect.objectContaining({
          companyId: 'osd',
          workType: 'equipment',
          markupPct: 15,
          priority: 100,
        }) as unknown,
        select: expect.anything() as unknown,
      },
      { prisma: {} },
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'pricing.markup.created' }),
      { prisma: {} },
    );
  });
});
