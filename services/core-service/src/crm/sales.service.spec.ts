import { Principal } from '@request-management/share';
import { DealsService } from './deals.service';
import { LeadsService } from './leads.service';

function principal(permissions: string[] = ['crm.sales.read', 'crm.sales.manage']): Principal {
  return {
    userId: 'me',
    displayName: 'ทดสอบ ขาย',
    activeCompanyId: 'osd',
    orgUnitId: 'unit-sales',
    ledUnitIds: [],
    scopedUnitIds: [],
    permissions,
  } as unknown as Principal;
}

function dealHarness(options: {
  found?: Record<string, unknown> | null;
  reason?: { code: string; name: string } | null;
  kycRules?: { productCode: string }[];
} = {}) {
  const audits: { eventType: string }[] = [];
  const timelineEvents: { eventType: string; summary: string }[] = [];

  const openDeal = {
    id: 'deal-1',
    dealCode: 'DL-OSD-000001',
    stage: 'negotiating',
    customerId: 'cust-1',
    companyId: 'osd',
    products: [{ productCode: 'SIP-TRUNK', name: null }],
    customer: { kycVerified: false },
  };

  const deals = {
    findFirst: jest.fn(() =>
      Promise.resolve(options.found === undefined ? openDeal : options.found),
    ),
    findMany: jest.fn(() => Promise.resolve([])),
    count: jest.fn(() => Promise.resolve(0)),
    create: jest.fn(() =>
      Promise.resolve({ id: 'deal-1', dealCode: 'DL-OSD-000001' }),
    ),
    update: jest.fn(() => Promise.resolve({})),
    sumAmount: jest.fn(() => Promise.resolve(0)),
  };
  const products = { createMany: jest.fn() };
  const lostReasons = {
    findFirst: jest.fn(() =>
      Promise.resolve(
        options.reason === undefined
          ? { code: 'price', name: 'ราคาสู้ไม่ได้' }
          : options.reason,
      ),
    ),
    findMany: jest.fn(() => Promise.resolve([])),
  };
  const customers = {
    findFirst: jest.fn(() =>
      Promise.resolve({ id: 'cust-1', nameTh: 'บริษัท กขค จำกัด' }),
    ),
  };
  const kycProducts = {
    findMany: jest.fn(() => Promise.resolve(options.kycRules ?? [])),
  };
  const codes = { issue: jest.fn(() => Promise.resolve('DL-OSD-000001')) };
  const timeline = {
    publish: jest.fn((event: { eventType: string; summary: string }) => {
      timelineEvents.push(event);
      return Promise.resolve();
    }),
  };
  const audit = {
    record: jest.fn((entry: { eventType: string }) => {
      audits.push(entry);
      return Promise.resolve();
    }),
  };
  const transactions = {
    execute: jest.fn((work: (prisma: unknown) => Promise<unknown>) =>
      work({ dealProduct: { deleteMany: jest.fn() } }),
    ),
  };

  const service = new DealsService(
    deals as never,
    products as never,
    lostReasons as never,
    customers as never,
    kycProducts as never,
    codes as never,
    timeline as never,
    audit as never,
    transactions as never,
  );

  return { service, deals, audits, timelineEvents, lostReasons };
}

describe('CRM ดีล — ปิดชนะ/แพ้ และคำเตือน KYC ระดับ product', () => {
  it('ปิดแพ้ด้วยเหตุผลนอกรายการมาตรฐาน = ถูกปฏิเสธ (spec CRM)', async () => {
    const { service } = dealHarness({ reason: null });

    await expect(
      service.lose('deal-1', { reason_code: 'made-up' }, principal()),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('ปิดแพ้สำเร็จ → audit crm.deal.lost + เหตุการณ์เข้าไทม์ไลน์ลูกค้า', async () => {
    const { service, audits, timelineEvents } = dealHarness();
    jest
      .spyOn(service, 'findOne')
      .mockResolvedValue({ id: 'deal-1' } as never);

    await service.lose(
      'deal-1',
      { reason_code: 'price', reason_text: 'ต่ำกว่าทุน' },
      principal(),
    );

    expect(audits.map((a) => a.eventType)).toContain('crm.deal.lost');
    expect(timelineEvents.map((t) => t.eventType)).toContain('deal.lost');
  });

  it('ดีลที่ปิดแล้วแก้ไข/ปิดซ้ำไม่ได้', async () => {
    const { service } = dealHarness({
      found: { id: 'deal-1', dealCode: 'DL-1', stage: 'won', customerId: 'c' },
    });

    await expect(service.win('deal-1', principal())).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('CM-04 ชุดงาน B — ดีลที่มี product เข้าเงื่อนไข + ลูกค้ายังไม่ KYC = คำเตือน ไม่ error', async () => {
    const { service } = dealHarness({
      kycRules: [{ productCode: 'SIP-TRUNK' }],
    });

    const deal = (await service.findOne('deal-1', principal())) as {
      kycWarning: { required: boolean; products: string[] };
    };

    expect(deal.kycWarning).toEqual({
      required: true,
      products: ['SIP-TRUNK'],
    });
  });

  it('SCOPE-03 ดีลนอกขอบเขต = 404', async () => {
    const { service } = dealHarness({ found: null });

    await expect(service.findOne('deal-x', principal())).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('CRM Lead — แปลงเป็นดีลโดยข้อมูลไหลต่อ', () => {
  function leadHarness(options: { status?: string } = {}) {
    const leads = {
      findFirst: jest.fn(() =>
        Promise.resolve({
          id: 'lead-1',
          name: 'บริษัท มุ่งหวัง จำกัด',
          status: options.status ?? 'qualified',
        }),
      ),
      findMany: jest.fn(() => Promise.resolve([])),
      count: jest.fn(() => Promise.resolve(0)),
      create: jest.fn(() => Promise.resolve({ id: 'lead-1' })),
      update: jest.fn(() => Promise.resolve({})),
    };
    const customers = {
      findFirst: jest.fn(() => Promise.resolve({ id: 'cust-1' })),
    };
    const deals = {
      create: jest.fn(() =>
        Promise.resolve({ id: 'deal-9', dealCode: 'DL-OSD-000009' }),
      ),
    };
    const audit = { record: jest.fn(() => Promise.resolve()) };
    const transactions = { execute: jest.fn() };

    const service = new LeadsService(
      leads as never,
      customers as never,
      deals as never,
      audit as never,
      transactions as never,
    );

    return { service, leads, deals };
  }

  it('convert สร้างดีลผ่าน DealsService แล้วปิด Lead เป็น converted พร้อมชี้ดีล', async () => {
    const { service, leads, deals } = leadHarness();

    const deal = await service.convert(
      'lead-1',
      { customer_id: 'cust-1' },
      principal(),
    );

    expect(deal.dealCode).toBe('DL-OSD-000009');
    expect(deals.create).toHaveBeenCalledWith(
      expect.objectContaining({ customer_id: 'cust-1' }),
      expect.anything(),
      { fromLeadId: 'lead-1' },
    );
    expect(leads.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'converted',
          convertedDealId: 'deal-9',
        }),
      }),
    );
  });

  it('Lead ที่ปิดแล้ว convert ซ้ำไม่ได้', async () => {
    const { service } = leadHarness({ status: 'converted' });

    await expect(
      service.convert('lead-1', { customer_id: 'cust-1' }, principal()),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
