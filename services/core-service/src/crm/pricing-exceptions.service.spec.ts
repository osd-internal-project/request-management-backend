import { Prisma } from '@prisma/client';
import type { Principal } from '@request-management/share';
import { PricingExceptionsService } from './pricing-exceptions.service';

const D = (value: number | string) => new Prisma.Decimal(value);

function quotation(lines: Record<string, unknown>[]) {
  return {
    id: 'qt-2',
    companyId: 'osd',
    quotationNo: 'QT-1',
    version: 2,
    opportunityId: 'opp-1',
    customerId: null,
    partyName: 'ลูกค้า',
    currency: 'THB',
    netTotal: D(20000),
    ownerUserId: 'sales',
    lines: lines.map((line, index) => ({
      lineNo: index + 1,
      productCode: null,
      description: `line ${index + 1}`,
      workType: null,
      unitPrice: D(100),
      lineTotal: D(10000),
      lineCost: D(5000),
      systemPrice: null,
      overrideReason: null,
      overriddenBy: null,
      ...line,
    })),
  };
}

function harness(options: { found?: unknown; deals?: { id: string }[] } = {}) {
  const tx = {
    pricingException: {
      upsert: jest.fn(() => Promise.resolve({})),
      updateMany: jest.fn(() => Promise.resolve({ count: 0 })),
    },
  };
  const exceptions = {
    upsert: jest.fn(() => Promise.resolve({})),
    findMany: jest.fn(() => Promise.resolve([] as unknown[])),
  };
  const quotations = {
    findFirst: jest.fn(() => Promise.resolve(options.found ?? null)),
    findMany: jest.fn(() => Promise.resolve([])),
  };
  const opportunities = {
    findFirst: jest.fn(() => Promise.resolve({ customerId: 'c-1' })),
    findMany: jest.fn(() => Promise.resolve(options.deals ?? [])),
  };
  const service = new PricingExceptionsService(
    exceptions as never,
    quotations as never,
    opportunities as never,
    {
      findFirst: jest.fn(() =>
        Promise.resolve({
          minMarginPct: 15,
          minMarginByWorkType: { service: 60 },
        }),
      ),
    } as never,
    {
      findFirst: jest.fn(() =>
        Promise.resolve({
          requestNo: 'PRA-0001',
          formData: { reason: 'QT-1 v2 · margin ต่ำ — ลูกค้ารายใหญ่' },
        }),
      ),
    } as never,
    {
      search: jest.fn(() =>
        Promise.resolve([
          {
            status: 'approved',
            steps: [{ decidedByUserId: 'boss' }, { decidedByUserId: null }],
          },
        ]),
      ),
    } as never,
    {
      findActiveByIds: jest.fn((ids: string[]) =>
        Promise.resolve(
          ids.map((id) => ({ id, displayName: `ชื่อ ${id}`, email: null })),
        ),
      ),
    } as never,
    {
      execute: (fn: (prisma: unknown) => Promise<unknown>) => fn(tx),
    } as never,
  );
  return { service, tx, exceptions, opportunities };
}

function principal(permissions: string[]): Principal {
  return {
    userId: 'me',
    displayName: 'me',
    activeCompanyId: 'osd',
    permissions,
  } as unknown as Principal;
}

describe('CD-205 ทะเบียนข้อยกเว้นด้านราคา', () => {
  it('คำขอได้ผล = บันทึก margin ต่ำต่อประเภทงาน และราคาที่แก้ด้วยมือ พร้อมเหตุผลและผู้อนุมัติ', async () => {
    const { service, tx } = harness({
      found: quotation([
        // service: 50% margin, minimum 60% → below
        { workType: 'service' },
        // equipment: 50% margin, company minimum 15% → fine, but overridden
        {
          workType: 'equipment',
          productCode: 'SIP',
          systemPrice: D(120),
          overrideReason: 'ลูกค้าเก่า',
          overriddenBy: 'mgr',
        },
      ]),
    });

    const count = await service.recordOutcome('req-1', 'approved');

    expect(count).toBe(2);
    const rows = (
      tx.pricingException.upsert.mock.calls as unknown as [
        {
          where: { requestId_kind_subjectKey: Record<string, string> };
          create: Record<string, unknown>;
        },
      ][]
    ).map(([call]) => call);
    expect(rows.map((row) => row.where.requestId_kind_subjectKey)).toEqual([
      { requestId: 'req-1', kind: 'margin_below', subjectKey: 'service' },
      { requestId: 'req-1', kind: 'price_override', subjectKey: '2:SIP' },
    ]);
    expect(rows[0].create).toMatchObject({
      quotationId: 'qt-2',
      version: 2,
      requestNo: 'PRA-0001',
      minMarginPct: 60,
      reason: 'QT-1 v2 · margin ต่ำ — ลูกค้ารายใหญ่',
      requestedByName: 'ชื่อ sales',
      decision: 'approved',
      approverIds: ['boss'],
      approverNames: ['ชื่อ boss'],
    });
    expect(rows[1].create).toMatchObject({
      productCode: 'SIP',
      reason: 'ลูกค้าเก่า',
      requestedBy: 'mgr',
      requestedByName: 'ชื่อ mgr',
    });
    // a subject the latest version no longer has is superseded, never deleted
    expect(tx.pricingException.updateMany).toHaveBeenCalledWith({
      where: {
        requestId: 'req-1',
        kind: 'margin_below',
        subjectKey: { notIn: ['service'] },
      },
      data: { decision: 'superseded' },
    });
    // the approver's chosen discount takes the outcome
    const chosen = (
      tx.pricingException.updateMany.mock.calls as unknown as [
        { where: { kind: string }; data: { decision: string } },
      ][]
    ).find(([call]) => call.where.kind === 'discount_option');
    expect(chosen?.[0].data.decision).toBe('approved');
  });

  it('คำขอที่ไม่มีใบเสนอราคารออยู่ = ไม่บันทึกอะไร', async () => {
    const { service, tx } = harness();
    expect(await service.recordOutcome('req-x', 'approved')).toBe(0);
    expect(tx.pricingException.upsert).not.toHaveBeenCalled();
  });

  it('ฝ่ายขายเห็นเฉพาะแถวของดีลที่ตนเห็น; Pricing เห็นทั้งหมด', async () => {
    const { service, exceptions, opportunities } = harness({
      deals: [{ id: 'opp-mine' }],
    });
    const row = (opportunityId: string) => ({
      opportunityId,
      marginPct: D(10),
      minMarginPct: D(15),
      systemPrice: null,
      unitPrice: null,
      netTotal: D(100),
    });
    exceptions.findMany.mockResolvedValue([row('opp-mine'), row('opp-other')]);

    const sales = await service.list(principal(['crm.sales.read']), {});
    expect(sales.items.map((item) => item.opportunityId)).toEqual(['opp-mine']);
    expect(opportunities.findMany).toHaveBeenCalled();

    const pricing = await service.list(principal(['pricing.price.read']), {});
    expect(pricing.items).toHaveLength(2);
    expect(pricing.items[0].marginPct).toBe('10.00');
  });

  it('ดีลที่กำลังทำ = ข้อยกเว้นของลูกค้ารายเดียวกันในดีลอื่น (รวมตอนเป็นผู้มุ่งหวัง)', async () => {
    const { service, exceptions } = harness({
      deals: [{ id: 'opp-old' }, { id: 'opp-now' }],
    });

    const result = await service.list(principal(['pricing.price.read']), {
      for_opportunity: 'opp-now',
    });

    expect(result.customerId).toBe('c-1');
    const [args] = exceptions.findMany.mock.calls[0] as unknown as [
      { where: Record<string, unknown> },
    ];
    expect(args.where).toMatchObject({
      OR: [
        { customerId: 'c-1' },
        { opportunityId: { in: ['opp-old', 'opp-now'] } },
      ],
      AND: [{ opportunityId: { not: 'opp-now' } }],
    });
  });

  it('ดีลที่ยังไม่มีลูกค้า = ไม่มีประวัติให้แสดง', async () => {
    const { service, opportunities, exceptions } = harness();
    opportunities.findFirst.mockResolvedValueOnce({
      customerId: null as unknown as string,
    });
    const result = await service.list(principal(['crm.sales.read']), {
      for_opportunity: 'opp-new',
    });
    expect(result.items).toEqual([]);
    expect(exceptions.findMany).not.toHaveBeenCalled();
  });

  it('ชนิดที่ไม่รู้จัก = VALIDATION_FAILED', async () => {
    const { service } = harness();
    await expect(
      service.list(principal(['pricing.price.read']), { kind: 'foo' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
