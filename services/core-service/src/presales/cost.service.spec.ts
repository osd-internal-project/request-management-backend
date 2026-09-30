import type { Principal } from '@request-management/share';
import { CostService } from './cost.service';

const presales = {
  userId: 'ps-1',
  activeCompanyId: 'osd',
  permissions: ['presales.solution.manage'],
} as unknown as Principal;
const seller = {
  userId: 'sales-1',
  activeCompanyId: 'osd',
  permissions: ['crm.sales.read', 'crm.sales.manage'],
} as unknown as Principal;

const BOQ = [
  {
    kind: 'equipment',
    productCode: 'FG-100F',
    name: 'FortiGate',
    quantity: 2,
    refUnitCost: null,
  },
];

function harness(
  options: {
    status?: string;
    rates?: unknown;
    vqType?: string | null;
    requestType?: string | null;
  } = {},
) {
  const manage = (actor: Principal) =>
    actor.permissions.includes('presales.solution.manage');
  const solutions = {
    requireManageable: jest.fn((_: string, actor: Principal) =>
      manage(actor)
        ? Promise.resolve({
            id: 'sol-1',
            companyId: 'osd',
            opportunityId: 'opp-1',
            title: 'SD-WAN',
          })
        : Promise.reject(Object.assign(new Error('x'), { code: 'FORBIDDEN' })),
    ),
    findOne: jest.fn(() => Promise.resolve({ id: 'sol-1' })),
  };
  const versions = {
    findFirst: jest.fn(() =>
      Promise.resolve({
        id: 'v-2',
        versionNo: 2,
        status: options.status ?? 'locked',
        boq: BOQ,
      }),
    ),
    updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
  };
  const quotes = {
    count: jest.fn(() => Promise.resolve(0)),
    findFirst: jest.fn(() => Promise.resolve({ seq: 1, vendorName: 'x' })),
    create: jest.fn(() => Promise.resolve({})),
    update: jest.fn(() => Promise.resolve({})),
  };
  const configs = {
    findFirst: jest.fn(() =>
      Promise.resolve({
        presalesLaborRates: options.rates ?? [{ role: 'Engineer', rate: 4500 }],
        vendorQuoteTypeCode:
          options.vqType === undefined ? 'VQ' : options.vqType,
      }),
    ),
  };
  const requests = {
    create: jest.fn(() => Promise.resolve({ id: 'req-vq', requestNo: null })),
  };
  const requestRows = {
    findFirst: jest.fn(() =>
      Promise.resolve(
        options.requestType === null
          ? null
          : { typeCode: options.requestType ?? 'VQ' },
      ),
    ),
  };
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const service = new CostService(
    solutions as never,
    versions as never,
    quotes as never,
    configs as never,
    {
      findFirst: jest.fn(() => Promise.resolve({ opportunityCode: 'OPP-001' })),
    } as never,
    requests as never,
    requestRows as never,
    audit as never,
    { execute: jest.fn((work: (p: unknown) => unknown) => work({})) } as never,
    { put: jest.fn(), get: jest.fn(), remove: jest.fn() },
  );
  return { service, versions, quotes, requests };
}

const argOf = (mock: jest.Mock) =>
  (mock.mock.calls[0] as unknown as [Record<string, unknown>])[0];

describe('CD-136 cost estimate', () => {
  it('CD-136: labour is saved on a locked version with the table rate copied in', async () => {
    const { service, versions } = harness();
    await service.saveLabor(
      'sol-1',
      2,
      { lines: [{ role: 'Engineer', mandays: 5 }] },
      presales,
    );
    expect(argOf(versions.updateMany)).toMatchObject({
      where: { id: 'v-2', status: { in: ['draft', 'locked'] } },
      data: { labor: [{ role: 'Engineer', mandays: 5, rate: 4500, note: '' }] },
    });
  });

  it("a superseded version's estimate is frozen", async () => {
    await expect(
      harness({ status: 'superseded' }).service.saveLabor(
        'sol-1',
        1,
        { lines: [] },
        presales,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('a partner quote is recorded against BOQ lines, linked to its VQ request', async () => {
    const { service, quotes } = harness();
    await service.saveQuote(
      'sol-1',
      2,
      null,
      {
        vendor_name: ' Fortinet TH ',
        vendor_code: 'V0001',
        quote_date: '2026-09-28',
        valid_until: '2026-10-28',
        request_id: 'req-vq',
        lines: [{ line_index: 0, unit_price: 38000 }],
      },
      presales,
    );
    expect(argOf(quotes.create)).toMatchObject({
      data: {
        vendorName: 'Fortinet TH',
        vendorCode: 'V0001',
        requestId: 'req-vq',
        lines: [{ lineIndex: 0, productCode: 'FG-100F', unitPrice: 38000 }],
        validUntil: new Date('2026-10-28T00:00:00Z'),
      },
    });
    await expect(
      harness({ requestType: 'SOL' }).service.saveQuote(
        'sol-1',
        2,
        null,
        {
          vendor_name: 'x',
          request_id: 'req-x',
          lines: [{ line_index: 0, unit_price: 1 }],
        },
        presales,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('CD-136: a VQ request is raised as a draft on the deal for the chosen lines', async () => {
    const { service, requests } = harness();
    await expect(
      service.requestVendorQuote('sol-1', 2, { line_indexes: [0] }, presales),
    ).resolves.toEqual({ request_id: 'req-vq', request_no: null });
    expect(argOf(requests.create)).toMatchObject({
      type_code: 'VQ',
      ref_type: 'opportunity',
      ref_id: 'OPP-001',
      form_data: { items: '1. FG-100F FortiGate × 2', version_no: '2' },
    });
    await expect(
      harness({ vqType: null }).service.requestVendorQuote(
        'sol-1',
        2,
        { line_indexes: [0] },
        presales,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('ROLE-01: sales read the estimate but do not write it', async () => {
    await expect(
      harness().service.saveLabor('sol-1', 2, { lines: [] }, seller),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
