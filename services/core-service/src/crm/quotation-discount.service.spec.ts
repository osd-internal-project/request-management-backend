import { Prisma } from '@prisma/client';
import type { Principal } from '@request-management/share';
import { QuotationDiscountService } from './quotation-discount.service';

const D = (value: number | string) => new Prisma.Decimal(value);

function line(
  lineNo: number,
  workType: string | null,
  price: number,
  cost: number,
  discountPct: number,
) {
  return {
    lineNo,
    productCode: null,
    description: `line ${lineNo}`,
    quantity: D(1),
    unit: null,
    unitPrice: D(price),
    unitCost: D(cost),
    discountPct: D(discountPct),
    priceId: null,
    priceModel: 'unit',
    termMonths: null,
    costSource: null,
    workType,
    markupPct: null,
  };
}

function principal(userId: string, permissions: string[]): Principal {
  return {
    userId,
    displayName: userId,
    activeCompanyId: 'osd',
    permissions,
  } as unknown as Principal;
}

function harness(options: { status?: string; caseStatus?: string } = {}) {
  const quotation = {
    id: 'qt-1',
    quotationNo: 'QT-1',
    version: 1,
    companyId: 'osd',
    opportunityId: 'opp-1',
    customerId: null,
    partyName: 'ลูกค้า',
    partyTaxId: null,
    contactName: null,
    title: 'SIP',
    status: options.status ?? 'pending_approval',
    currency: 'THB',
    validUntil: null,
    paymentTerms: null,
    note: null,
    vatPct: D(7),
    minMarginPct: D(15),
    approvalRequestId: 'req-1',
    submittedAt: new Date(),
    solutionId: null,
    solutionVersionNo: null,
    ownerUserId: 'sales',
    ownerOrgUnitId: null,
    lines: [
      // service: gross 10,000 cost 7,000, discount 20% → margin 12.5%
      line(1, 'service', 10000, 7000, 20),
      // equipment: gross 10,000 cost 5,000, discount 10% → margin 44.4%
      line(2, 'equipment', 10000, 5000, 10),
    ],
  };
  const quotations = {
    findFirst: jest.fn(() => Promise.resolve(quotation)),
    create: jest.fn(() => Promise.resolve({ id: 'qt-2' })),
  };
  const configs = {
    findFirst: jest.fn(() =>
      Promise.resolve({
        minMarginPct: 15,
        minMarginByWorkType: { service: 20 },
      }),
    ),
  };
  const cases = {
    search: jest.fn(() =>
      Promise.resolve([
        {
          id: 'case-1',
          status: 'pending',
          currentStep: 1,
          steps: [
            {
              stepNo: 1,
              status: 'pending',
              approverUserId: 'boss',
              candidateUserIds: [],
              decidedByUserId: null,
            },
          ],
        },
      ]),
    ),
  };
  const approvals = {
    decide: jest.fn(() =>
      Promise.resolve({ status: options.caseStatus ?? 'approved' }),
    ),
  };
  const tx = {
    quotation: {
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
    },
  };
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const service = new QuotationDiscountService(
    quotations as never,
    configs as never,
    cases as never,
    approvals as never,
    { publish: jest.fn() } as never,
    audit as never,
    {
      execute: (fn: (prisma: unknown) => Promise<unknown>) => fn(tx),
    } as never,
  );
  return { service, quotations, approvals, tx, audit };
}

describe('CD-203 บริหารส่วนลด', () => {
  it('ผู้อนุมัติเห็น margin ก่อน/หลังส่วนลดต่อประเภทงาน และทางเลือกที่ยังอยู่ในเกณฑ์', async () => {
    const { service } = harness();

    const view = await service.impact(
      'req-1',
      principal('boss', ['approval.decide']),
    );

    expect(view.costVisible).toBe(true);
    expect(view.canChoose).toBe(true);
    const service_ = view.groups.find((g) => g.workType === 'service')!;
    expect(service_).toMatchObject({
      marginBeforePct: '30.00',
      marginPct: '12.50',
      minMarginPct: 20,
      below: true,
      // 1 − 7,000 / (10,000 × 0.8) = 12.5%
      maxDiscountPct: 12.5,
    });
    expect(view.suggestion?.caps).toEqual({ service: 12.5 });
    expect(
      view.suggestion?.groups.find((g) => g.workType === 'service'),
    ).toMatchObject({ marginPct: '20.00', below: false });
  });

  it('ผู้มีแค่ crm.sales.read เห็นยอดและส่วนลด ไม่เห็นต้นทุน/margin/ทางเลือก', async () => {
    const { service } = harness();

    const view = await service.impact(
      'req-1',
      principal('viewer', ['crm.sales.read']),
    );

    expect(view.costVisible).toBe(false);
    expect(view.canChoose).toBe(false);
    expect(view.suggestion).toBeNull();
    expect(view.totals).not.toHaveProperty('cost');
    expect(view.groups[0]).not.toHaveProperty('marginPct');
    expect(view.lines[0]).not.toHaveProperty('cost');
  });

  it('ไม่ใช่ผู้อนุมัติและไม่มีสิทธิ์ CRM = 404', async () => {
    const { service } = harness();
    await expect(
      service.impact('req-1', principal('other', ['approval.decide'])),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('เลือกทางเลือก = อนุมัติขั้นของตน แล้วออกเวอร์ชันใหม่ตามเพดาน ผูกคำขอเดิม', async () => {
    const { service, approvals, quotations, tx } = harness();

    await service.choose(
      'req-1',
      { caps: { service: 12.5 }, note: 'ลดได้แค่นี้' },
      principal('boss', ['approval.decide']),
    );

    const [caseId, decision] = approvals.decide.mock.calls[0] as unknown as [
      string,
      { decision: string; note: string },
    ];
    expect(caseId).toBe('case-1');
    expect(decision.decision).toBe('approve');
    expect(decision.note).toContain('บริการ ไม่เกิน 12.5%');
    expect(decision.note).toContain('ลดได้แค่นี้');

    const [move] = tx.quotation.updateMany.mock.calls[0] as unknown as [
      { where: unknown; data: { status: string } },
    ];
    expect(move.where).toEqual({
      id: 'qt-1',
      status: { in: ['pending_approval', 'approved'] },
    });
    expect(move.data.status).toBe('superseded');
    const [args] = quotations.create.mock.calls[0] as unknown as [
      {
        data: {
          version: number;
          status: string;
          approvalRequestId: string;
          lines: { create: { discountPct: number }[] };
        };
      },
    ];
    expect(args.data).toMatchObject({
      version: 2,
      // the last level approved, so the chosen version is the approved one
      status: 'approved',
      approvalRequestId: 'req-1',
    });
    expect(args.data.lines.create.map((l) => l.discountPct)).toEqual([
      12.5, 10,
    ]);
  });

  it('ยังมีขั้นถัดไป = เวอร์ชันใหม่ยังรออนุมัติ', async () => {
    const { service, quotations } = harness({ caseStatus: 'pending' });

    await service.choose(
      'req-1',
      { caps: { service: 12.5 } },
      principal('boss', ['approval.decide']),
    );

    const [args] = quotations.create.mock.calls[0] as unknown as [
      { data: { status: string } },
    ];
    expect(args.data.status).toBe('pending_approval');
  });

  it('ทางเลือกที่ไม่ได้ลดส่วนลดลง = VALIDATION_FAILED ไม่อนุมัติอะไร', async () => {
    const { service, approvals } = harness();

    await expect(
      service.choose(
        'req-1',
        { caps: { service: 30 } },
        principal('boss', ['approval.decide']),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(approvals.decide).not.toHaveBeenCalled();
  });

  it('เพดานของประเภทที่ไม่รู้จักหรือเกิน 100 = VALIDATION_FAILED', async () => {
    const { service } = harness();
    await expect(
      service.choose(
        'req-1',
        { caps: { foo: 5 } },
        principal('boss', ['approval.decide']),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('ใบที่ไม่ได้รออนุมัติแล้ว = เลือกไม่ได้', async () => {
    const { service, approvals } = harness({ status: 'approved' });
    await expect(
      service.choose(
        'req-1',
        { caps: { service: 12.5 } },
        principal('boss', ['approval.decide']),
      ),
    ).rejects.toMatchObject({ code: 'CRM_QUOTATION_STATE_INVALID' });
    expect(approvals.decide).not.toHaveBeenCalled();
  });

  it('ผู้อนุมัติถูกปฏิเสธโดยระบบอนุมัติ = ไม่ออกเวอร์ชันใหม่', async () => {
    const { service, approvals, quotations } = harness();
    approvals.decide.mockImplementationOnce(() =>
      Promise.reject(new Error('not your step')),
    );
    await expect(
      service.choose(
        'req-1',
        { caps: { service: 12.5 } },
        principal('intruder', ['approval.decide']),
      ),
    ).rejects.toThrow('not your step');
    expect(quotations.create).not.toHaveBeenCalled();
  });
});
