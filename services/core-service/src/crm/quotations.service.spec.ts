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
  };
  const requestsService = {
    create: jest.fn(
      options.requestCreate ?? (() => Promise.resolve({ id: 'req-9' })),
    ),
  };

  // CD-27 — the SAP catalog check; individual tests make it reject.
  const catalog = { assertKnownCodes: jest.fn(() => Promise.resolve()) };
  const service = new QuotationsService(
    quotations as never,
    { findFirst: jest.fn() } as never,
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
  );

  return { service, quotations, tx, requestsService, audits, catalog };
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
      deal_value: 23000,
      discount_pct: 8,
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
