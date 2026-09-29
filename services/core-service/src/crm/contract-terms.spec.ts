import type { Principal } from '@request-management/share';
import {
  approvalStateOf,
  liabilityNeedsApproval,
  penaltyCeiling,
  termProblems,
  warrantyPeriod,
} from './contract-terms';
import { ContractTermsService } from './contract-terms.service';

describe('CD-153..156 contract term rules', () => {
  it('a liability cap above the contract value, or none at all, needs executives', () => {
    const cap = (amount: number | null, unlimited = false) => ({
      liabilityUnlimited: unlimited,
      liabilityCapAmount: amount,
    });
    expect(liabilityNeedsApproval(cap(500_000), 1_000_000)).toBe(false);
    expect(liabilityNeedsApproval(cap(1_000_000), 1_000_000)).toBe(false);
    expect(liabilityNeedsApproval(cap(1_500_000), 1_000_000)).toBe(true);
    expect(liabilityNeedsApproval(cap(null, true), 1_000_000)).toBe(true);
    // no value to compare with: only "unlimited" asks
    expect(liabilityNeedsApproval(cap(9_999_999), null)).toBe(false);
    expect(liabilityNeedsApproval(cap(null, true), null)).toBe(true);
  });

  it('the penalty ceiling in money: an amount as given, a percentage of the value', () => {
    expect(
      penaltyCeiling({ penaltyCapPct: 10, penaltyCapAmount: null }, 1_234_567),
    ).toBe(123_456.7);
    expect(
      penaltyCeiling({ penaltyCapPct: null, penaltyCapAmount: 50_000 }, null),
    ).toBe(50_000);
    expect(
      penaltyCeiling({ penaltyCapPct: 10, penaltyCapAmount: null }, null),
    ).toBeNull();
  });

  it('the warranty runs from acceptance, not signing — and not before acceptance', () => {
    expect(warrantyPeriod('2026-10-15', 12)).toEqual({
      startsOn: '2026-10-15',
      endsOn: '2027-10-14',
    });
    expect(warrantyPeriod('2026-01-31', 1)).toEqual({
      startsOn: '2026-01-31',
      endsOn: '2026-02-27',
    });
    expect(warrantyPeriod(null, 12)).toBeNull();
  });

  it('names what does not add up', () => {
    expect(
      termProblems({
        liabilityUnlimited: true,
        liabilityCapAmount: 100,
        penaltyRatePct: 0.1,
        penaltyBasis: 'other',
        penaltyCapPct: 150,
        terminationSteps: ['แจ้งลูกค้า', ' '],
      }),
    ).toEqual([
      'ความรับผิดเลือกได้อย่างเดียว — ไม่จำกัด หรือระบุเพดาน',
      'ฐานคำนวณค่าปรับ "อื่น ๆ" ต้องอธิบาย',
      'อัตราค่าปรับต้องมีรอบคิดและฐานคำนวณ',
      'เพดานค่าปรับเกินร้อยละ 100 ของมูลค่าสัญญา',
      'ขั้นตอนเมื่อยกเลิกสัญญาต้องไม่ว่าง',
    ]);
    expect(
      termProblems({
        penaltyRatePct: 0.1,
        penaltyPeriod: 'day',
        penaltyBasis: 'contract_value',
        penaltyCapPct: 10,
      }),
    ).toEqual([]);
  });

  it('the approval state follows the request', () => {
    expect(approvalStateOf(false, null)).toBe('not_needed');
    expect(approvalStateOf(true, null)).toBe('missing');
    expect(approvalStateOf(true, { status: 'pending_approval' })).toBe(
      'pending',
    );
    expect(approvalStateOf(true, { status: 'approved' })).toBe('approved');
    expect(approvalStateOf(true, { status: 'rejected' })).toBe('rejected');
    expect(approvalStateOf(true, { status: 'draft' })).toBe('draft');
  });
});

const legal = {
  userId: 'u-legal',
  activeCompanyId: 'osd',
  displayName: 'ฝ่ายกฎหมาย',
  permissions: ['legal.contract.read', 'legal.contract.manage'],
} as unknown as Principal;

function harness(options: { typeCode?: string | null; submitFails?: boolean }) {
  let row: Record<string, unknown> | null = null;
  const terms = {
    findFirst: jest.fn(() => Promise.resolve(row)),
    upsert: jest.fn(
      (args: {
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        row = row ? { ...row, ...args.update } : { ...args.create };
        return Promise.resolve(row);
      },
    ),
    update: jest.fn((args: { data: Record<string, unknown> }) => {
      row = { ...row, ...args.data };
      return Promise.resolve(row);
    }),
  };
  const requests = {
    create: jest.fn(() => Promise.resolve({ id: 'req-1' })),
    submit: jest.fn(() =>
      options.submitFails
        ? Promise.reject(new Error('ต้องระบุผู้รับเรื่อง'))
        : Promise.resolve({}),
    ),
  };
  const service = new ContractTermsService(
    terms as never,
    {
      findFirst: jest.fn(() =>
        Promise.resolve({
          id: 'c-1',
          companyId: 'osd',
          contractNo: 'CTR-001',
          title: 'บริการดูแลระบบ',
          value: 1_000_000,
          counterpartyName: null,
          customer: { nameTh: 'บริษัท ลูกค้า จำกัด' },
        }),
      ),
    } as never,
    {
      findFirst: jest.fn(() =>
        Promise.resolve({
          liabilityApprovalRequestTypeCode:
            options.typeCode === undefined ? 'LIA' : options.typeCode,
        }),
      ),
    } as never,
    {
      findFirst: jest.fn(() =>
        Promise.resolve({
          id: 'req-1',
          requestNo: 'LIA-001',
          status: 'pending_approval',
        }),
      ),
    } as never,
    requests as never,
    { record: jest.fn(() => Promise.resolve()) } as never,
    { changed: jest.fn(() => Promise.resolve(0)) } as never,
  );
  return { service, requests, current: () => row };
}

describe('CD-153 ContractTermsService — the executives’ approval', () => {
  it('a cap above the value raises and submits the request; saving the same cap again asks nothing new', async () => {
    const { service, requests } = harness({});
    const view = await service.save(
      'c-1',
      { liability_cap_amount: 2_000_000 },
      legal,
      'Bearer t',
    );
    expect(requests.create).toHaveBeenCalledWith(
      expect.objectContaining({
        type_code: 'LIA',
        ref_type: 'contract',
        ref_id: 'CTR-001',
      }),
      legal,
    );
    expect(requests.submit).toHaveBeenCalledWith('req-1', legal, 'Bearer t');
    expect(view.liability.approval).toEqual({
      state: 'pending',
      request: {
        id: 'req-1',
        requestNo: 'LIA-001',
        status: 'pending_approval',
      },
      error: null,
    });

    await service.save(
      'c-1',
      { liability_cap_amount: 2_000_000, warranty_months: 12 },
      legal,
      'Bearer t',
    );
    expect(requests.create).toHaveBeenCalledTimes(1);
  });

  it('within the value nothing is asked; no request type set is said on the card', async () => {
    const within = harness({});
    const view = await within.service.save(
      'c-1',
      { liability_cap_amount: 500_000 },
      legal,
      'Bearer t',
    );
    expect(within.requests.create).not.toHaveBeenCalled();
    expect(view.liability.approval.state).toBe('not_needed');

    const unset = harness({ typeCode: null });
    const blocked = await unset.service.save(
      'c-1',
      { liability_unlimited: true },
      legal,
      'Bearer t',
    );
    expect(unset.requests.create).not.toHaveBeenCalled();
    expect(blocked.liability.approval.state).toBe('missing');
    expect(blocked.liability.approval.error).toContain(
      'ยังไม่ได้ตั้งประเภทคำขอ',
    );
  });

  it('a submit that fails keeps the draft and says why — the terms stay saved', async () => {
    const { service, current } = harness({ submitFails: true });
    const view = await service.save(
      'c-1',
      {
        liability_unlimited: true,
        penalty_rate_pct: 0.1,
        penalty_period: 'day',
        penalty_basis: 'contract_value',
      },
      legal,
      'Bearer t',
    );
    expect(current()).toMatchObject({
      liabilityUnlimited: true,
      liabilityApprovalRequestId: 'req-1',
      penaltyRatePct: 0.1,
    });
    expect(view.liability.approval.error).toContain('ยื่นไม่ผ่าน');
  });
});
