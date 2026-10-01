import { Prisma } from '@prisma/client';
import { AppError, Principal } from '@request-management/share';
import { QuotationsService } from './quotations.service';
import { QuotationApprovalSyncService } from './quotation-approval-sync.service';

/**
 * CD-76 — "ฉบับที่ส่งลูกค้าแล้วแก้ไม่ได้ ต้องออกเวอร์ชันใหม่ · รวมการตรวจ margin ก่อน
 * ออกใบเสนอราคา". Pinned here: the margin check's two branches, the approval
 * request it drafts, the lock on anything past draft, expiry, and the sync that
 * brings the approval outcome back.
 */

const D = (value: string | number) => new Prisma.Decimal(value);

function principal(): Principal {
  return {
    userId: 'me',
    displayName: 'ทดสอบ ขาย',
    activeCompanyId: 'osd',
    orgUnitId: 'unit-sales',
    ledUnitIds: [],
    scopedUnitIds: [],
    permissions: ['crm.sales.read', 'crm.sales.manage'],
  } as unknown as Principal;
}

function futureDate(): Date {
  return new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
}

function quotationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'qt-1',
    quotationNo: 'QT-OSD-000001',
    version: 1,
    companyId: 'osd',
    opportunityId: 'opp-1',
    customerId: null,
    partyName: 'บริษัท ผู้มุ่งหวัง จำกัด',
    title: 'SIP Trunk',
    status: 'draft',
    currency: 'THB',
    validUntil: futureDate(),
    paymentTerms: null,
    note: null,
    subtotal: D(25000),
    discountTotal: D(2000),
    netTotal: D(23000),
    vatPct: D(7),
    vatAmount: D(1610),
    grandTotal: D(24610),
    costTotal: D(15000),
    marginAmount: D(8000),
    marginPct: D('34.78'),
    approvalRequestId: null,
    ownerUserId: 'me',
    ownerOrgUnitId: 'unit-sales',
    lines: [{ lineNo: 1 }],
    ...overrides,
  };
}

function harness(
  options: {
    row?: Record<string, unknown>;
    minMarginPct?: number;
    requestCreate?: () => Promise<unknown>;
    updateCount?: number;
    prices?: unknown[];
    segments?: { valueId: string }[];
    dealCustomerId?: string | null;
  } = {},
) {
  const audits: { eventType: string; after?: Record<string, unknown> }[] = [];
  const row = quotationRow(options.row);

  const quotations = {
    findFirst: jest.fn(() => Promise.resolve(row)),
    findMany: jest.fn(() => Promise.resolve([])),
    create: jest.fn(),
    update: jest.fn(),
  };
  const tx = {
    quotation: {
      updateMany: jest.fn(() =>
        Promise.resolve({ count: options.updateCount ?? 1 }),
      ),
    },
    quotationLine: {
      deleteMany: jest.fn(() => Promise.resolve({ count: 0 })),
      createMany: jest.fn(() => Promise.resolve({ count: 1 })),
    },
  };
  const requestsService = {
    create: jest.fn(
      options.requestCreate ?? (() => Promise.resolve({ id: 'req-9' })),
    ),
  };

  // CD-27 — the SAP catalog check; individual tests make it reject.
  const catalog = { assertKnownCodes: jest.fn(() => Promise.resolve()) };
  // CD-195 — standard prices a line may name (none by default).
  const prices = {
    findMany: jest.fn(() => Promise.resolve(options.prices ?? [])),
  };
  // CD-197 — the groups the deal's customer sits in.
  const segmentAssignments = {
    findMany: jest.fn(() => Promise.resolve(options.segments ?? [])),
  };
  const service = new QuotationsService(
    quotations as never,
    {
      findFirst: jest.fn(() =>
        Promise.resolve({ customerId: options.dealCustomerId ?? null }),
      ),
    } as never,
    {
      findFirst: jest.fn(() =>
        Promise.resolve({
          minMarginPct: options.minMarginPct ?? 15,
          quotationValidityDays: 30,
          vatPct: 7,
          quotationApprovalTypeCode: 'DSC',
        }),
      ),
    } as never,
    requestsService as never,
    { findFirst: jest.fn(() => Promise.resolve(null)) } as never,
    { issueUnused: jest.fn(() => Promise.resolve('QT-OSD-000001')) } as never,
    { publish: jest.fn() } as never,
    {
      record: jest.fn((entry: (typeof audits)[number]) => {
        audits.push(entry);
        return Promise.resolve();
      }),
    } as never,
    {
      execute: jest.fn((work: (prisma: unknown) => Promise<unknown>) =>
        work(tx),
      ),
    } as never,
    catalog as never,
    prices as never,
    segmentAssignments as never,
  );

  return {
    service,
    quotations,
    tx,
    requestsService,
    audits,
    catalog,
    prices,
  };
}

describe('CD-76 ใบเสนอราคา — ตรวจ margin ตอนยื่น', () => {
  it('margin ถึงเกณฑ์ = อนุมัติทันที ไม่สร้างคำขอ และเก็บเกณฑ์ที่ใช้ลงใบ', async () => {
    const { service, tx, requestsService, audits } = harness();

    await service.submit('qt-1', {}, principal());

    expect(requestsService.create).not.toHaveBeenCalled();
    const call = tx.quotation.updateMany.mock.calls[0] as unknown as [
      { where: { status: { in: string[] } }; data: Record<string, unknown> },
    ];
    expect(call[0].where.status.in).toEqual(['draft']);
    expect(call[0].data).toMatchObject({
      status: 'approved',
      minMarginPct: 15,
      approvalRequired: false,
    });
    expect(audits.map((a) => a.eventType)).toContain('crm.quotation.approved');
  });

  it('margin ต่ำกว่าเกณฑ์แต่ไม่ให้เหตุผล = VALIDATION_FAILED และไม่แตะอะไรเลย', async () => {
    const { service, tx, requestsService } = harness({ minMarginPct: 40 });

    await expect(service.submit('qt-1', {}, principal())).rejects.toMatchObject(
      {
        code: 'VALIDATION_FAILED',
      },
    );
    expect(requestsService.create).not.toHaveBeenCalled();
    expect(tx.quotation.updateMany).not.toHaveBeenCalled();
  });

  it('margin ต่ำกว่าเกณฑ์ = ร่างคำขอ DSC อ้างใบเสนอราคาพร้อมตัวเลข แล้วใบรออนุมัติ', async () => {
    const { service, tx, requestsService } = harness({ minMarginPct: 40 });

    await service.submit('qt-1', { reason: 'ลูกค้ารายใหญ่' }, principal());

    const [dto] = requestsService.create.mock.calls[0] as unknown as [
      {
        type_code: string;
        ref_type: string;
        ref_id: string;
        form_data: Record<string, unknown>;
      },
    ];
    expect(dto.type_code).toBe('DSC');
    expect(dto.ref_type).toBe('quotation');
    expect(dto.ref_id).toBe('qt-1');
    expect(dto.form_data).toMatchObject({
      customer_name: 'บริษัท ผู้มุ่งหวัง จำกัด',
      // CD-80: the value before discount + the cost, the computed form's inputs
      deal_value: 25000,
      discount_pct: 8,
      cost: 15000,
      est_margin_pct: 34.78,
    });
    // CD-127 — the margin travels only in the masked field, never in free text
    expect(String(dto.form_data.reason)).not.toContain('34.78');
    expect(String(dto.form_data.reason)).toContain('ลูกค้ารายใหญ่');

    const call = tx.quotation.updateMany.mock.calls[0] as unknown as [
      { data: Record<string, unknown> },
    ];
    expect(call[0].data).toMatchObject({
      status: 'pending_approval',
      approvalRequired: true,
      approvalRequestId: 'req-9',
      minMarginPct: 40,
    });
  });

  it('ประเภทคำขอไม่เปิดให้บริษัทนี้ = CRM_QUOTATION_APPROVAL_UNAVAILABLE และใบยังเป็นร่าง', async () => {
    const { service, tx } = harness({
      minMarginPct: 40,
      requestCreate: () =>
        Promise.reject(new AppError('NOT_FOUND', 'ไม่พบประเภทคำขอที่ระบุ')),
    });

    await expect(
      service.submit('qt-1', { reason: 'ลูกค้ารายใหญ่' }, principal()),
    ).rejects.toMatchObject({ code: 'CRM_QUOTATION_APPROVAL_UNAVAILABLE' });
    expect(tx.quotation.updateMany).not.toHaveBeenCalled();
  });

  it('ไม่มีรายการ = ยื่นไม่ได้', async () => {
    const { service } = harness({ row: { lines: [] } });

    await expect(service.submit('qt-1', {}, principal())).rejects.toMatchObject(
      {
        code: 'VALIDATION_FAILED',
      },
    );
  });

  it('สองคลิกแข่งกัน — ตัวที่แพ้ได้ CRM_QUOTATION_STATE_INVALID ไม่ใช่ audit ซ้ำ', async () => {
    const { service, audits } = harness({ updateCount: 0 });

    await expect(service.submit('qt-1', {}, principal())).rejects.toMatchObject(
      {
        code: 'CRM_QUOTATION_STATE_INVALID',
      },
    );
    expect(audits).toHaveLength(0);
  });
});

describe('CD-76 ใบเสนอราคา — ล็อกฉบับและวันหมดอายุ', () => {
  it('แก้ใบที่ส่งแล้วไม่ได้ ต้องออกเวอร์ชันใหม่', async () => {
    const { service, quotations } = harness({ row: { status: 'sent' } });

    await expect(
      service.update('qt-1', { title: 'แก้ชื่อ' }, principal()),
    ).rejects.toMatchObject({ code: 'CRM_QUOTATION_STATE_INVALID' });
    expect(quotations.update).not.toHaveBeenCalled();
  });

  it('ส่งใบที่หมดอายุแล้วไม่ได้', async () => {
    const { service, tx } = harness({
      row: { status: 'approved', validUntil: new Date('2020-01-01T00:00:00Z') },
    });

    await expect(service.send('qt-1', principal())).rejects.toMatchObject({
      code: 'CRM_QUOTATION_EXPIRED',
    });
    expect(tx.quotation.updateMany).not.toHaveBeenCalled();
  });

  it('ใบร่างไม่ต้องออกเวอร์ชันใหม่ — แก้ได้เลย', async () => {
    const { service } = harness();

    await expect(service.revise('qt-1', principal())).rejects.toMatchObject({
      code: 'CRM_QUOTATION_STATE_INVALID',
    });
  });
});

describe('CD-76 ผลคำขออนุมัติกลับมาที่ใบเสนอราคา', () => {
  function syncHarness(found: Record<string, unknown> | null, count = 1) {
    const audits: { eventType: string }[] = [];
    const tx = {
      quotation: { updateMany: jest.fn(() => Promise.resolve({ count })) },
    };
    const quotations = { findFirst: jest.fn(() => Promise.resolve(found)) };
    const sync = new QuotationApprovalSyncService(
      { on: jest.fn() } as never,
      quotations as never,
      { publish: jest.fn() } as never,
      {
        record: jest.fn((entry: { eventType: string }) => {
          audits.push(entry);
          return Promise.resolve();
        }),
      } as never,
      {
        execute: jest.fn((work: (prisma: unknown) => Promise<unknown>) =>
          work(tx),
        ),
      } as never,
    );
    return { sync, tx, quotations, audits };
  }

  const payload = {
    company_id: 'osd',
    request_id: 'req-9',
    request_no: 'OSD-DSC-202609-0001',
    type_code: 'DSC',
    requester_id: 'me',
  };
  const pending = {
    id: 'qt-1',
    quotationNo: 'QT-OSD-000001',
    version: 1,
    companyId: 'osd',
    customerId: null,
  };

  it('คำขออนุมัติแล้ว → ใบเป็น approved หาด้วย approvalRequestId เฉพาะใบที่ยังรออยู่', async () => {
    const { sync, tx, quotations, audits } = syncHarness(pending);

    await sync.onRequestOutcome(payload, 'approved');

    const [query] = quotations.findFirst.mock.calls[0] as unknown as [
      { where: Record<string, unknown> },
    ];
    expect(query.where).toEqual({
      approvalRequestId: 'req-9',
      status: 'pending_approval',
    });
    const call = tx.quotation.updateMany.mock.calls[0] as unknown as [
      { data: Record<string, unknown> },
    ];
    expect(call[0].data.status).toBe('approved');
    expect(audits.map((a) => a.eventType)).toEqual(['crm.quotation.approved']);
  });

  it('ไม่อนุมัติ → กลับเป็นร่าง', async () => {
    const { sync, tx, audits } = syncHarness(pending);

    await sync.onRequestOutcome(payload, 'rejected');

    const call = tx.quotation.updateMany.mock.calls[0] as unknown as [
      { data: Record<string, unknown> },
    ];
    expect(call[0].data.status).toBe('draft');
    expect(audits.map((a) => a.eventType)).toEqual([
      'crm.quotation.approval_failed',
    ]);
  });

  it('event ซ้ำ / ใบถูกออกเวอร์ชันใหม่ไปแล้ว = ไม่มีอะไรเปลี่ยน', async () => {
    const { sync, tx, audits } = syncHarness(null);

    await sync.onRequestOutcome(payload, 'approved');

    expect(tx.quotation.updateMany).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
  });

  it('CD-27 แก้รายการด้วยรหัสสินค้าที่ SAP ไม่รู้จัก = VALIDATION_FAILED และไม่บันทึกอะไร', async () => {
    const { service, quotations, catalog } = harness();
    catalog.assertKnownCodes.mockRejectedValueOnce(
      Object.assign(new Error('unknown'), {
        code: 'VALIDATION_FAILED',
      }),
    );

    await expect(
      service.update(
        'qt-1',
        {
          lines: [
            {
              product_code: 'TYPO-123',
              description: 'x',
              quantity: 1,
              unit_price: 100,
            },
          ],
        },
        principal(),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(catalog.assertKnownCodes).toHaveBeenCalledWith('osd', [
      expect.objectContaining({ product_code: 'TYPO-123' }),
    ]);
    expect(quotations.update).not.toHaveBeenCalled();
  });
});

describe('CD-195 ราคามาตรฐานบนบรรทัดใบเสนอราคา', () => {
  const line = (price_id: string, unit_price = 1250) => ({
    product_code: 'SIP-TRUNK',
    description: 'SIP Trunk',
    quantity: 1,
    unit_price,
    price_id,
  });

  it('เก็บ price_id เฉพาะราคาที่ยังมีผล รหัสตรง และราคาเท่ากัน — ที่เหลือถือว่ากรอกเอง', async () => {
    const { service, tx } = harness({
      prices: [
        {
          id: 'p-1',
          productCode: 'SIP-TRUNK',
          unitPrice: D(1250),
          priceModel: 'unit',
          scope: 'standard',
        },
      ],
    });
    await service.update(
      'qt-1',
      { lines: [line('p-1'), line('p-1', 1300), line('p-gone')] },
      principal(),
    );
    const data = (
      tx.quotationLine.createMany.mock.calls[0] as unknown as [
        { data: { priceId: string | null }[] },
      ]
    )[0].data;
    expect(data.map((row) => row.priceId)).toEqual(['p-1', null, null]);
  });

  it('ยื่นไม่ได้ถ้าราคามาตรฐานที่บรรทัดใช้ไม่มีผลแล้ว', async () => {
    const { service, audits } = harness({
      row: {
        lines: [{ lineNo: 1, productCode: 'SIP-TRUNK', priceId: 'p-old' }],
      },
      prices: [],
    });
    await expect(service.submit('qt-1', {}, principal())).rejects.toMatchObject(
      { code: 'CONFLICT' },
    );
    expect(audits).toHaveLength(0);
  });

  it('ยื่นได้เมื่อราคายังมีผล', async () => {
    const { service } = harness({
      row: {
        lines: [{ lineNo: 1, productCode: 'SIP-TRUNK', priceId: 'p-1' }],
      },
      prices: [{ id: 'p-1' }],
    });
    await expect(
      service.submit('qt-1', {}, principal()),
    ).resolves.toBeDefined();
  });
});

describe('CD-196 รูปแบบราคาบนบรรทัดใบเสนอราคา', () => {
  it('เหมาเก็บจำนวน 1 เสมอ รายเดือนเก็บจำนวนเดือน ต่อหน่วยไม่มีเดือน', async () => {
    const { service, tx } = harness();
    await service.update(
      'qt-1',
      {
        lines: [
          {
            description: 'ติดตั้ง',
            quantity: 5,
            unit_price: 20000,
            price_model: 'lump_sum',
          },
          {
            description: 'MA',
            quantity: 2,
            unit_price: 500,
            price_model: 'monthly',
            term_months: 12,
          },
          {
            description: 'อุปกรณ์',
            quantity: 3,
            unit_price: 1000,
            term_months: 6,
          },
        ],
      },
      principal(),
    );
    const data = (
      tx.quotationLine.createMany.mock.calls[0] as unknown as [
        {
          data: {
            quantity: number;
            priceModel: string;
            termMonths: number | null;
            lineTotal: Prisma.Decimal;
          }[];
        },
      ]
    )[0].data;
    expect(
      data.map((row) => [
        row.quantity,
        row.priceModel,
        row.termMonths,
        row.lineTotal.toFixed(2),
      ]),
    ).toEqual([
      [1, 'lump_sum', null, '20000.00'],
      [2, 'monthly', 12, '12000.00'],
      [3, 'unit', null, '3000.00'],
    ]);
  });

  it('รายเดือนไม่ระบุเดือน = VALIDATION_FAILED และไม่บันทึกอะไร', async () => {
    const { service, quotations } = harness();
    await expect(
      service.update(
        'qt-1',
        {
          lines: [
            {
              description: 'MA',
              quantity: 1,
              unit_price: 500,
              price_model: 'monthly',
            },
          ],
        },
        principal(),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(quotations.update).not.toHaveBeenCalled();
  });

  it('ราคามาตรฐานรูปแบบไม่ตรงกับบรรทัด = ไม่นับเป็นราคามาตรฐาน', async () => {
    const { service, tx } = harness({
      prices: [
        {
          id: 'p-1',
          productCode: 'MA',
          unitPrice: D(500),
          priceModel: 'monthly',
          scope: 'standard',
        },
      ],
    });
    await service.update(
      'qt-1',
      {
        lines: [
          {
            product_code: 'MA',
            description: 'MA',
            quantity: 1,
            unit_price: 500,
            price_id: 'p-1',
          },
        ],
      },
      principal(),
    );
    const data = (
      tx.quotationLine.createMany.mock.calls[0] as unknown as [
        { data: { priceId: string | null }[] },
      ]
    )[0].data;
    expect(data[0].priceId).toBeNull();
  });
});

describe('CD-197 ราคาเฉพาะบนบรรทัดใบเสนอราคา', () => {
  const special = (over: Record<string, unknown>) => ({
    id: 'p-sp',
    productCode: 'SIP-TRUNK',
    unitPrice: D(900),
    priceModel: 'unit',
    scope: 'customer',
    customerId: 'c-1',
    segmentValueId: null,
    opportunityId: null,
    ...over,
  });
  const line = {
    product_code: 'SIP-TRUNK',
    description: 'SIP',
    quantity: 1,
    unit_price: 900,
    price_id: 'p-sp',
  };
  const kept = async (options: Parameters<typeof harness>[0]) => {
    const { service, tx } = harness(options);
    await service.update('qt-1', { lines: [line] }, principal());
    return (
      tx.quotationLine.createMany.mock.calls[0] as unknown as [
        { data: { priceId: string | null }[] },
      ]
    )[0].data[0].priceId;
  };

  it('ราคาเฉพาะลูกค้านับเฉพาะใบของลูกค้ารายนั้น', async () => {
    expect(await kept({ prices: [special({})], dealCustomerId: 'c-1' })).toBe(
      'p-sp',
    );
    expect(
      await kept({ prices: [special({})], dealCustomerId: 'c-2' }),
    ).toBeNull();
  });

  it('ราคาเฉพาะดีลนับเฉพาะดีลนั้น; ราคากลุ่มนับเมื่อลูกค้าอยู่ในกลุ่ม', async () => {
    expect(
      await kept({
        prices: [
          special({
            scope: 'opportunity',
            customerId: null,
            opportunityId: 'opp-1',
          }),
        ],
      }),
    ).toBe('p-sp');
    expect(
      await kept({
        prices: [
          special({
            scope: 'opportunity',
            customerId: null,
            opportunityId: 'opp-9',
          }),
        ],
      }),
    ).toBeNull();
    expect(
      await kept({
        prices: [
          special({
            scope: 'segment',
            customerId: null,
            segmentValueId: 'seg-1',
          }),
        ],
        dealCustomerId: 'c-1',
        segments: [{ valueId: 'seg-1' }],
      }),
    ).toBe('p-sp');
  });
});

describe('CD-198 ที่มาของต้นทุนบนบรรทัดที่สร้างจาก Solution', () => {
  it('แก้ใบแล้วที่มาคงอยู่เฉพาะบรรทัดที่สินค้าและต้นทุนเดิม', async () => {
    const { service, tx } = harness({
      row: {
        lines: [
          {
            lineNo: 1,
            productCode: 'FG-100F',
            unitCost: D(38000),
            costSource: 'ใบเสนอราคาคู่ค้า: ก',
          },
          {
            lineNo: 2,
            productCode: 'MA',
            unitCost: D(1000),
            costSource: 'ต้นทุนอ้างอิง (BOQ)',
          },
        ],
      },
    });
    await service.update(
      'qt-1',
      {
        lines: [
          {
            product_code: 'FG-100F',
            description: 'FortiGate',
            quantity: 2,
            unit_price: 50000,
            unit_cost: 38000,
          },
          {
            product_code: 'MA',
            description: 'MA',
            quantity: 1,
            unit_price: 1500,
            unit_cost: 900,
          },
        ],
      },
      principal(),
    );
    const data = (
      tx.quotationLine.createMany.mock.calls[0] as unknown as [
        { data: { costSource: string | null }[] },
      ]
    )[0].data;
    expect(data.map((row) => row.costSource)).toEqual([
      'ใบเสนอราคาคู่ค้า: ก',
      null,
    ]);
  });
});

describe('CD-199 margin ของดีล', () => {
  it('รวมเวอร์ชันล่าสุดที่ยังมีผล พร้อมเกณฑ์ margin ของบริษัท', async () => {
    const { service, quotations } = harness({ dealCustomerId: null });
    quotations.findMany.mockResolvedValueOnce([
      {
        id: 'q1',
        quotationNo: 'QT-1',
        version: 2,
        status: 'sent',
        validUntil: futureDate(),
        netTotal: D(10000),
        costTotal: D(8000),
      },
      {
        id: 'q0',
        quotationNo: 'QT-1',
        version: 1,
        status: 'superseded',
        validUntil: futureDate(),
        netTotal: D(1),
        costTotal: D(1),
      },
    ] as never);
    const result = await service.dealMarginOf('opp-1', principal());
    expect(result.quotations.map((row) => row.id)).toEqual(['q1']);
    expect(result.marginPct?.toFixed(2)).toBe('20.00');
    expect(result.minMarginPct).toBe(15);
  });
});
