import type { Principal } from '@request-management/share';
import { SolutionQuotationService } from './solution-quotation.service';

const pricer = {
  userId: 'pr-1',
  activeCompanyId: 'osd',
  permissions: ['pricing.price.manage', 'crm.sales.read'],
} as unknown as Principal;
const viewer = {
  userId: 'v-1',
  activeCompanyId: 'osd',
  permissions: ['crm.sales.read'],
} as unknown as Principal;

const BOQ = [
  {
    kind: 'equipment',
    productCode: 'FG-100F',
    name: 'FortiGate',
    model: '100F',
    description: '',
    quantity: 2,
    unit: 'เครื่อง',
    refUnitCost: 40000,
  },
  {
    kind: 'service',
    productCode: 'MA-YEARLY',
    name: 'MA',
    model: '',
    description: 'รายปี',
    quantity: 1,
    unit: 'งาน',
    refUnitCost: 1000,
  },
];

function harness(
  options: {
    approval?: string;
    complete?: boolean;
    existing?: { id: string } | null;
  } = {},
) {
  const solutions = {
    requireReadable: jest.fn(() =>
      Promise.resolve({
        id: 'sol-1',
        companyId: 'osd',
        opportunityId: 'opp-1',
        title: 'SD-WAN',
      }),
    ),
    estimateOf: jest.fn(() =>
      Promise.resolve({
        complete: options.complete ?? true,
        missing_cost: options.complete === false ? 1 : 0,
        lines: [
          {
            index: 0,
            productCode: 'FG-100F',
            name: 'FortiGate',
            quantity: 2,
            unitCost: 38000,
            source: 'quote',
            vendorName: 'ผู้จัดจำหน่าย ก',
            expired: false,
          },
          {
            index: 1,
            productCode: 'MA-YEARLY',
            name: 'MA',
            quantity: 1,
            unitCost: 1000,
            source: 'reference',
            vendorName: null,
            expired: false,
          },
        ],
        labor: [
          { role: 'Engineer', mandays: 5, rate: 4500, note: '' },
          { role: 'PM', mandays: 0, rate: 7000, note: '' },
        ],
      }),
    ),
  };
  const versions = {
    findFirst: jest.fn(() =>
      Promise.resolve({
        approvalStatus: options.approval ?? 'approved',
        boq: BOQ,
      }),
    ),
  };
  const opportunities = {
    findFirst: jest.fn(() => Promise.resolve({ currency: 'THB' })),
  };
  const quotationRows = {
    findFirst: jest.fn(() => Promise.resolve(options.existing ?? null)),
    findMany: jest.fn(() => Promise.resolve([])),
  };
  const quotations = {
    createForOpportunity: jest.fn(() => Promise.resolve({ id: 'qt-new' })),
    findOne: jest.fn((id: string) => Promise.resolve({ id })),
  };
  const prices = {
    lookup: jest.fn(() =>
      Promise.resolve({
        'MA-YEARLY': {
          price_id: 'p-ma',
          price_model: 'monthly',
          scope: 'customer',
          unit_price: 500,
          currency: 'THB',
          valid_from: '2026-01-01',
          valid_to: null,
        },
      }),
    ),
  };
  const service = new SolutionQuotationService(
    solutions as never,
    versions as never,
    opportunities as never,
    quotationRows as never,
    quotations as never,
    prices as never,
  );
  return { service, quotations, prices };
}

describe('SolutionQuotationService (CD-198)', () => {
  it('builds the draft from the BOQ with cost, cost source, prices and labour', async () => {
    const { service, quotations, prices } = harness();
    const result = await service.create('sol-1', 2, pricer);

    expect(result).toMatchObject({ id: 'qt-new', existing: false });
    expect(prices.lookup).toHaveBeenCalledWith(
      pricer,
      ['FG-100F', 'MA-YEARLY'],
      'THB',
      undefined,
      'opp-1',
    );
    const [opportunityId, dto, , origin] = quotations.createForOpportunity.mock
      .calls[0] as unknown as [
      string,
      { title: string; lines: Record<string, unknown>[] },
      Principal,
      { solutionId: string; solutionVersionNo: number; costSources: string[] },
    ];
    expect(opportunityId).toBe('opp-1');
    expect(dto.title).toBe('SD-WAN');
    expect(dto.lines).toEqual([
      expect.objectContaining({
        product_code: 'FG-100F',
        description: 'FortiGate · 100F',
        quantity: 2,
        unit_cost: 38000,
        unit_price: 0,
      }),
      expect.objectContaining({
        product_code: 'MA-YEARLY',
        unit_cost: 1000,
        unit_price: 500,
        price_id: 'p-ma',
        price_model: 'monthly',
        term_months: 12,
      }),
      expect.objectContaining({
        description: 'ค่าแรง: Engineer',
        quantity: 5,
        unit: 'man-day',
        unit_cost: 4500,
        unit_price: 0,
      }),
    ]);
    expect(origin).toEqual({
      solutionId: 'sol-1',
      solutionVersionNo: 2,
      costSources: [
        'ใบเสนอราคาคู่ค้า: ผู้จัดจำหน่าย ก',
        'ต้นทุนอ้างอิง (BOQ)',
        'อัตราแรงงาน',
      ],
    });
  });

  it('refuses a version not approved or not ready for Pricing', async () => {
    await expect(
      harness({ approval: 'pending' }).service.create('sol-1', 2, pricer),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      harness({ complete: false }).service.create('sol-1', 2, pricer),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('returns the quotation already started from this version instead of a second', async () => {
    const { service, quotations } = harness({ existing: { id: 'qt-old' } });
    expect(await service.create('sol-1', 2, pricer)).toMatchObject({
      id: 'qt-old',
      existing: true,
    });
    expect(quotations.createForOpportunity).not.toHaveBeenCalled();
  });

  it('needs Pricing or a salesperson who may manage sales', async () => {
    await expect(
      harness().service.create('sol-1', 2, viewer),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
