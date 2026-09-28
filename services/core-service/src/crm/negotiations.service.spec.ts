import { AppError, type Principal } from '@request-management/share';
import { NegotiationsService } from './negotiations.service';
import { evaluateTerms, nonStandardLines, normalizeTerm } from './trade-terms';

const STANDARDS = [
  { code: 'PAYMENT', name: 'เครดิตการชำระเงิน', standardValue: '30 วัน' },
  { code: 'WARRANTY', name: 'การรับประกัน', standardValue: '1 ปี' },
];

describe('CD-79 trade terms against the standard', () => {
  it('same value up to spacing and case is standard; anything else is flagged', () => {
    expect(normalizeTerm('  30   วัน ')).toBe('30 วัน');
    const { terms, problems } = evaluateTerms(
      [
        { code: 'PAYMENT', agreed: '30  วัน' },
        { code: 'WARRANTY', agreed: '2 ปี', note: 'ลูกค้าขอ' },
      ],
      STANDARDS,
    );
    expect(problems).toEqual([]);
    expect(terms.map((t) => [t.code, t.nonStandard, t.standard])).toEqual([
      ['PAYMENT', false, '30 วัน'],
      ['WARRANTY', true, '1 ปี'],
    ]);
  });

  it('a term outside the list is non-standard by definition, and needs a name', () => {
    const { terms, problems } = evaluateTerms(
      [{ name: 'ค่าปรับล่าช้า', agreed: 'ไม่มีค่าปรับ' }, { agreed: 'x' }],
      STANDARDS,
    );
    expect(terms[0]).toMatchObject({ code: null, nonStandard: true });
    expect(problems).toEqual(['เงื่อนไขที่ 2: เงื่อนไขนอกรายการต้องมีชื่อ']);
  });

  it('unknown code, repeated term and empty value are all named', () => {
    const { problems } = evaluateTerms(
      [
        { code: 'NOPE', agreed: '1' },
        { code: 'PAYMENT', agreed: '45 วัน' },
        { code: 'PAYMENT', agreed: '60 วัน' },
        { code: 'WARRANTY', agreed: ' ' },
      ],
      STANDARDS,
    );
    expect(problems).toEqual([
      'เงื่อนไขที่ 1: ไม่รู้จักเงื่อนไขมาตรฐาน "NOPE"',
      'เงื่อนไขที่ 3: "เครดิตการชำระเงิน" ซ้ำในรอบเดียวกัน',
      'เงื่อนไขที่ 4: ต้องระบุค่าที่ตกลง',
    ]);
  });

  it('Legal reads each flagged term against its standard', () => {
    const { terms } = evaluateTerms(
      [
        { code: 'PAYMENT', agreed: '30 วัน' },
        { code: 'WARRANTY', agreed: '2 ปี', note: 'ลูกค้าขอ' },
        { name: 'ค่าปรับ', agreed: 'ยกเว้น' },
      ],
      STANDARDS,
    );
    expect(nonStandardLines(terms)).toBe(
      '• การรับประกัน: ตกลง "2 ปี" (มาตรฐาน "1 ปี") — ลูกค้าขอ\n' +
        '• ค่าปรับ: ตกลง "ยกเว้น" (ไม่มีในเงื่อนไขมาตรฐาน)',
    );
  });
});

const me = {
  userId: 'sales-1',
  activeCompanyId: 'osd',
  displayName: 'ฝ่ายขาย',
  permissions: ['crm.sales.manage', 'crm.sales.read'],
} as unknown as Principal;

function harness(options: {
  stage?: string;
  contractType?: string | null;
  createFails?: boolean;
  submitFails?: boolean;
}) {
  const created: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const deal = {
    id: 'opp-1',
    companyId: 'osd',
    opportunityCode: 'OPP-OSD-0001',
    title: 'ระบบกล้อง',
    stage: options.stage ?? 'negotiating',
    customerId: 'cus-1',
    prospectName: null,
    amount: 500000,
    customer: { nameTh: 'บริษัท ลูกค้า จำกัด' },
  };
  const rounds = {
    findFirst: jest.fn((args: { where: Record<string, unknown> }) =>
      Promise.resolve(
        'id' in args.where
          ? { id: 'round-1', ...updates.at(-1) }
          : { roundNo: 2 },
      ),
    ),
    create: jest.fn((args: { data: Record<string, unknown> }) => {
      created.push(args.data);
      return Promise.resolve({ id: 'round-1', roundNo: args.data.roundNo });
    }),
    update: jest.fn((args: { data: Record<string, unknown> }) => {
      updates.push(args.data);
      return Promise.resolve({});
    }),
  };
  const requests = {
    create: jest.fn(() =>
      options.createFails
        ? Promise.reject(new AppError('NOT_FOUND', 'ไม่พบประเภทคำขอ'))
        : Promise.resolve({ id: 'req-1' }),
    ),
    submit: jest.fn(() =>
      options.submitFails
        ? Promise.reject(
            new AppError('VALIDATION_FAILED', 'ต้องระบุผู้รับเรื่อง'),
          )
        : Promise.resolve({}),
    ),
  };
  const timeline = { publish: jest.fn(() => Promise.resolve()) };
  const service = new NegotiationsService(
    { findFirst: jest.fn(() => Promise.resolve(deal)) } as never,
    rounds as never,
    { findMany: jest.fn(() => Promise.resolve(STANDARDS)) } as never,
    {
      findFirst: jest.fn(() =>
        Promise.resolve({
          contractRequestTypeCode:
            options.contractType === undefined ? 'CTR' : options.contractType,
        }),
      ),
    } as never,
    { findMany: jest.fn(() => Promise.resolve([])) } as never,
    requests as never,
    timeline as never,
    { record: jest.fn(() => Promise.resolve()) } as never,
    { execute: jest.fn((work: (p: unknown) => unknown) => work({})) } as never,
  );
  return { service, created, updates, requests, timeline };
}

const round = (terms: { code?: string; name?: string; agreed: string }[]) => ({
  occurred_on: '2026-09-28',
  summary: 'ลูกค้าขอเครดิตยาวขึ้น',
  terms,
});

describe('CD-79 NegotiationsService.record', () => {
  it('CD-79: all standard — the round is saved as round 3 and nothing goes to Legal', async () => {
    const { service, created, requests } = harness({});
    await service.record(
      'opp-1',
      round([{ code: 'PAYMENT', agreed: '30 วัน' }]),
      me,
      'Bearer t',
    );
    expect(created[0]).toMatchObject({ roundNo: 3, nonStandardCount: 0 });
    expect(requests.create).not.toHaveBeenCalled();
  });

  it('CD-79: a non-standard term creates and submits a contract review to Legal, linked to the deal', async () => {
    const { service, updates, requests } = harness({});
    await service.record(
      'opp-1',
      round([{ code: 'PAYMENT', agreed: '60 วัน' }]),
      me,
      'Bearer t',
    );
    expect(requests.create).toHaveBeenCalledWith(
      expect.objectContaining({
        type_code: 'CTR',
        ref_type: 'opportunity',
        ref_id: 'OPP-OSD-0001',
        form_data: expect.objectContaining({
          counterparty: 'บริษัท ลูกค้า จำกัด',
          contract_value: 500000,
          non_standard_terms:
            '• เครดิตการชำระเงิน: ตกลง "60 วัน" (มาตรฐาน "30 วัน")',
        }) as unknown,
      }),
      me,
    );
    expect(requests.submit).toHaveBeenCalledWith('req-1', me, 'Bearer t');
    expect(updates[0]).toEqual({
      legalRequestId: 'req-1',
      legalSendError: null,
    });
  });

  it('no contract type set: the round is kept and says why Legal did not get it', async () => {
    const { service, updates, requests } = harness({ contractType: null });
    await service.record(
      'opp-1',
      round([{ code: 'PAYMENT', agreed: '60 วัน' }]),
      me,
      'Bearer t',
    );
    expect(requests.create).not.toHaveBeenCalled();
    expect(updates[0]).toMatchObject({
      legalRequestId: null,
      legalSendError: expect.stringContaining(
        'ยังไม่ได้ตั้งประเภทคำขอสัญญา',
      ) as unknown,
    });
  });

  it('submit refused: the draft is kept for the salesperson to finish, with the reason', async () => {
    const { service, updates } = harness({ submitFails: true });
    await service.record(
      'opp-1',
      round([{ name: 'ค่าปรับ', agreed: 'ยกเว้น' }]),
      me,
      'Bearer t',
    );
    expect(updates[0]).toMatchObject({
      legalRequestId: 'req-1',
      legalSendError: expect.stringContaining(
        'ต้องระบุผู้รับเรื่อง',
      ) as unknown,
    });
  });

  it('create refused: no request, the reason is kept', async () => {
    const { service, updates } = harness({ createFails: true });
    await service.record(
      'opp-1',
      round([{ code: 'WARRANTY', agreed: '3 ปี' }]),
      me,
      'Bearer t',
    );
    expect(updates[0]).toMatchObject({
      legalRequestId: null,
      legalSendError: expect.stringContaining('ไม่พบประเภทคำขอ') as unknown,
    });
  });

  it('a closed deal cannot take a new round; a bad term is refused before anything is saved', async () => {
    const closed = harness({ stage: 'won' });
    await expect(
      closed.service.record(
        'opp-1',
        round([{ code: 'PAYMENT', agreed: '30 วัน' }]),
        me,
        'x',
      ),
    ).rejects.toThrow('ปิดแล้ว');

    const bad = harness({});
    await expect(
      bad.service.record(
        'opp-1',
        round([{ code: 'NOPE', agreed: '1' }]),
        me,
        'x',
      ),
    ).rejects.toThrow('ไม่รู้จักเงื่อนไขมาตรฐาน');
    expect(bad.created).toHaveLength(0);
  });
});

describe('CD-79 replacing the standard terms', () => {
  function adminHarness() {
    const standards = {
      findMany: jest.fn(() => Promise.resolve([])),
      upsert: jest.fn(() => Promise.resolve({})),
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
    };
    const audit = { record: jest.fn(() => Promise.resolve()) };
    const service = new NegotiationsService(
      {} as never,
      {} as never,
      standards as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      audit as never,
      {
        execute: jest.fn((work: (p: unknown) => unknown) => work({})),
      } as never,
    );
    return { service, standards, audit };
  }

  it('codes left out are deactivated, not deleted; the change is audited', async () => {
    const { service, standards, audit } = adminHarness();
    await service.replaceStandards(
      {
        terms: [
          { code: 'PAYMENT', name: 'เครดิต', standard_value: '30 วัน' },
          { code: 'WARRANTY', name: 'ประกัน', standard_value: '1 ปี' },
        ],
      },
      me,
    );
    expect(standards.upsert).toHaveBeenCalledTimes(2);
    expect(standards.updateMany).toHaveBeenCalledWith(
      {
        where: {
          companyId: 'osd',
          code: { notIn: ['PAYMENT', 'WARRANTY'] },
          active: true,
        },
        data: { active: false, updatedBy: 'sales-1' },
      },
      { prisma: {} },
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'crm.trade_terms.replaced' }),
      { prisma: {} },
    );
  });

  it('a repeated code is refused', async () => {
    const { service } = adminHarness();
    await expect(
      service.replaceStandards(
        {
          terms: [
            { code: 'PAYMENT', name: 'a', standard_value: '1' },
            { code: 'PAYMENT', name: 'b', standard_value: '2' },
          ],
        },
        me,
      ),
    ).rejects.toThrow('รหัสเงื่อนไขซ้ำ: PAYMENT');
  });
});
