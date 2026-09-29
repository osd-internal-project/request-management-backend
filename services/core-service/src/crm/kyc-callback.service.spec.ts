import { KycCallbackService } from './kyc-callback.service';
import {
  addMonths,
  bangkokDay,
  kycDates,
  readReviewerAnswers,
  screenAgainst,
  suggestRisk,
} from './kyc-rules';
import { normalizeCustomerName } from './customer-name';

const NOW = new Date('2026-09-29T03:00:00Z'); // 29 Sep 2026, Bangkok

const entry = (name: string, taxId: string | null = null) => ({
  id: `wl-${name}`,
  name,
  normalizedName: normalizeCustomerName(name),
  taxId,
  reason: 'รายชื่อคว่ำบาตร',
});

describe('CD-61 KYC rules', () => {
  it('screening: same tax id is a match whatever the name; a near-identical name is too', () => {
    const matches = screenAgainst(
      { nameTh: 'บริษัท กขค เทรดดิ้ง จำกัด', taxId: '0105551234567' },
      [
        entry('บจก. อื่น ๆ', '0-1055-51234-56-7'),
        entry('กขค เทรดดิ้ง'),
        entry('บริษัท ไม่เกี่ยว จำกัด'),
      ],
    );
    expect(matches.map((m) => [m.name, m.byTaxId])).toEqual([
      ['บจก. อื่น ๆ', true],
      ['กขค เทรดดิ้ง', false],
    ]);
    expect(matches[1].score).toBeGreaterThanOrEqual(0.85);
  });

  it('suggestion: a match is high, a missing document medium, otherwise low', () => {
    const hit = screenAgainst({ nameTh: 'กขค', taxId: '1' }, [entry('x', '1')]);
    expect(suggestRisk({ matches: hit, missingDocs: [] })).toBe('high');
    expect(suggestRisk({ matches: [], missingDocs: ['VAT20'] })).toBe('medium');
    expect(suggestRisk({ matches: [], missingDocs: [] })).toBe('low');
  });

  it('the reviewer form is read in Thai or English, and junk is ignored', () => {
    expect(
      readReviewerAnswers({
        risk_level: 'สูง',
        documents_expire_on: '2027-03-31',
        signatories: ' นาย ก (กรรมการ) ',
        screening_clearance: 'ชื่อพ้อง คนละนิติบุคคล',
      }),
    ).toEqual({
      riskLevel: 'high',
      documentsExpireOn: '2027-03-31',
      signatories: 'นาย ก (กรรมการ)',
      clearanceNote: 'ชื่อพ้อง คนละนิติบุคคล',
    });
    expect(
      readReviewerAnswers({ risk_level: 'maybe', documents_expire_on: 'x' }),
    ).toEqual({
      riskLevel: null,
      documentsExpireOn: null,
      signatories: null,
      clearanceNote: null,
    });
  });

  it('review date follows the risk; an earlier document expiry wins', () => {
    const months = { high: 12, medium: 24, low: 36 };
    expect(kycDates('2026-09-29', 'high', months, null)).toEqual({
      reviewDueOn: '2027-09-29',
      expiresOn: '2027-09-29',
    });
    expect(kycDates('2026-09-29', 'low', months, '2027-01-15')).toEqual({
      reviewDueOn: '2029-09-29',
      expiresOn: '2027-01-15',
    });
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(bangkokDay(new Date('2026-09-29T20:00:00Z'))).toBe('2026-09-30');
  });
});

function harness(options: {
  refType?: string | null;
  formData?: Record<string, unknown>;
  attachedDocs?: string[];
  watchlist?: ReturnType<typeof entry>[];
  existingRecord?: boolean;
  kycVerified?: boolean;
}) {
  const created: Record<string, unknown>[] = [];
  const customerUpdates: Record<string, unknown>[] = [];
  const audits: { eventType: string }[] = [];
  const timelineEvents: { eventType: string; summary: string }[] = [];
  const superseded: unknown[] = [];

  const requests = {
    findFirst: jest.fn(() =>
      Promise.resolve({
        id: 'req-1',
        requestNo: 'OSD-KYC-202609-0001',
        refType: options.refType === undefined ? 'customer' : options.refType,
        refId: 'cust-1',
        receiverFormData: options.formData ?? {},
        assigneeUserId: 'reviewer-1',
        receiverUserId: 'reviewer-1',
        requestType: {
          requiredDocs: [
            { code: 'COMPANY_CERT', name: 'หนังสือรับรอง' },
            { code: 'VAT20', name: 'ภ.พ.20' },
          ],
        },
        attachments: (options.attachedDocs ?? ['COMPANY_CERT', 'VAT20']).map(
          (docCode) => ({ docCode, deletedAt: null }),
        ),
      }),
    ),
  };
  const customers = {
    findFirst: jest.fn(() =>
      Promise.resolve({
        id: 'cust-1',
        companyId: 'osd',
        customerCode: 'CUS-OSD-000001',
        nameTh: 'บริษัท กขค เทรดดิ้ง จำกัด',
        nameEn: null,
        taxId: '0105551234567',
        kycVerified: options.kycVerified ?? false,
        kycRiskLevel: null,
        kycExpiresOn: null,
      }),
    ),
    update: jest.fn((args: { data: Record<string, unknown> }) => {
      customerUpdates.push(args.data);
      return Promise.resolve({});
    }),
  };
  const records = {
    findFirst: jest.fn(() =>
      Promise.resolve(options.existingRecord ? { id: 'rec-0' } : null),
    ),
    create: jest.fn((args: { data: Record<string, unknown> }) => {
      created.push(args.data);
      return Promise.resolve({ id: 'rec-1' });
    }),
    updateMany: jest.fn((args: unknown) => {
      superseded.push(args);
      return Promise.resolve({ count: 1 });
    }),
  };
  const service = new KycCallbackService(
    { on: jest.fn() } as never,
    requests as never,
    customers as never,
    { createMany: jest.fn(() => Promise.resolve({ count: 1 })) } as never,
    {
      publish: jest.fn((event: { eventType: string; summary: string }) => {
        timelineEvents.push(event);
        return Promise.resolve();
      }),
    } as never,
    {
      record: jest.fn((event: { eventType: string }) => {
        audits.push(event);
        return Promise.resolve();
      }),
    } as never,
    records as never,
    {
      findMany: jest.fn(() => Promise.resolve(options.watchlist ?? [])),
    } as never,
    { findFirst: jest.fn(() => Promise.resolve(null)) } as never,
  );
  return {
    service,
    created,
    customerUpdates,
    audits,
    timelineEvents,
    superseded,
    records,
  };
}

const completed = { request_id: 'req-1', type_code: 'KYC' };

describe('CM-04 / CD-61 KYC callback — a completed KYC request verifies the customer', () => {
  it('CD-61: clean screening, the reviewer’s risk and dates → a verified record and the customer summary', async () => {
    const h = harness({
      formData: {
        risk_level: 'กลาง',
        documents_expire_on: '2027-03-31',
        signatories: 'นาย ก',
      },
    });
    await h.service.onRequestCompleted(completed, NOW);

    expect(h.created[0]).toMatchObject({
      status: 'verified',
      riskLevel: 'medium',
      suggestedRisk: 'low',
      signatories: 'นาย ก',
      recordedBy: 'reviewer-1',
    });
    // medium = 24 months, but the document runs out first
    expect(h.created[0].expiresOn).toEqual(new Date('2027-03-31T00:00:00Z'));
    expect(h.customerUpdates[0]).toMatchObject({
      kycVerified: true,
      kycRiskLevel: 'medium',
      kycExpiresOn: new Date('2027-03-31T00:00:00Z'),
    });
    expect(h.superseded).toHaveLength(1);
    expect(h.audits.map((a) => a.eventType)).toEqual([
      'crm.customer.kyc_verified',
    ]);
  });

  it('CD-61: no risk chosen → the suggestion; a missing document makes it medium', async () => {
    const h = harness({ attachedDocs: ['COMPANY_CERT'] });
    await h.service.onRequestCompleted(completed, NOW);
    expect(h.created[0]).toMatchObject({
      riskLevel: 'medium',
      suggestedRisk: 'medium',
    });
    expect(h.created[0].screening).toMatchObject({ missingDocs: ['VAT20'] });
  });

  it('CD-61: a prohibited-list match with no clearance does NOT verify', async () => {
    const h = harness({ watchlist: [entry('ใครก็ได้', '0105551234567')] });
    await h.service.onRequestCompleted(completed, NOW);

    expect(h.created[0]).toMatchObject({
      status: 'screening_hit',
      suggestedRisk: 'high',
    });
    expect(h.customerUpdates).toHaveLength(0);
    expect(h.audits.map((a) => a.eventType)).toEqual([
      'crm.customer.kyc_screening_hit',
    ]);
    expect(h.timelineEvents[0].summary).toContain('ไม่ผ่าน');
  });

  it('CD-61: a match cleared by the reviewer verifies, recorded as high with the note', async () => {
    const h = harness({
      watchlist: [entry('ใครก็ได้', '0105551234567')],
      formData: { screening_clearance: 'ตรวจแล้วคนละนิติบุคคล' },
    });
    await h.service.onRequestCompleted(completed, NOW);
    expect(h.created[0]).toMatchObject({
      status: 'verified',
      riskLevel: 'high',
      clearanceNote: 'ตรวจแล้วคนละนิติบุคคล',
    });
    expect(h.customerUpdates[0]).toMatchObject({ kycVerified: true });
    expect(h.timelineEvents[0].summary).toContain('ยกเว้นรายชื่อต้องห้าม');
  });

  it('a re-verification of an already verified customer is recorded (it is a review)', async () => {
    const h = harness({ kycVerified: true });
    await h.service.onRequestCompleted(completed, NOW);
    expect(h.created).toHaveLength(1);
    expect(h.customerUpdates[0]).toMatchObject({ kycVerified: true });
  });

  it('idempotent by request — a re-emitted event records nothing twice', async () => {
    const h = harness({ existingRecord: true });
    await h.service.onRequestCompleted(completed, NOW);
    expect(h.created).toHaveLength(0);
    expect(h.customerUpdates).toHaveLength(0);
  });

  it('CM-04 a non-KYC completion, or a KYC without a customer ref, does nothing', async () => {
    const other = harness({});
    await other.service.onRequestCompleted(
      { request_id: 'req-1', type_code: 'DSC' },
      NOW,
    );
    expect(other.created).toHaveLength(0);

    const noRef = harness({ refType: null });
    await noRef.service.onRequestCompleted(completed, NOW);
    expect(noRef.created).toHaveLength(0);
  });
});
