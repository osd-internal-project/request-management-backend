import type { Principal } from '@request-management/share';
import {
  opinionKey,
  opinionNeeded,
  riskProblems,
  signReadiness,
} from './contract-risk';
import { ContractRiskService } from './contract-risk.service';

const issue = (title: string, escalate = false, severity = 'medium') => ({
  title,
  severity,
  escalate,
});

describe('CD-158 legal risk rules', () => {
  it('high and critical go to the executives; so does any issue marked for them', () => {
    expect(opinionNeeded('low', [issue('a')])).toBe(false);
    expect(opinionNeeded('medium', [issue('a')])).toBe(false);
    expect(opinionNeeded('medium', [issue('a', true)])).toBe(true);
    expect(opinionNeeded('high', [])).toBe(true);
    expect(opinionNeeded('critical', [])).toBe(true);
    expect(opinionNeeded(null, [issue('a', true)])).toBe(false);
  });

  it('asks again only when the level or the issues put to them change', () => {
    const asked = opinionKey('high', [
      issue('ค่าปรับไม่จำกัด', true),
      issue('x'),
    ]);
    // in-house issues and order do not matter
    expect(
      opinionKey('high', [issue('y'), issue(' ค่าปรับไม่จำกัด ', true)]),
    ).toBe(asked);
    expect(opinionKey('critical', [issue('ค่าปรับไม่จำกัด', true)])).not.toBe(
      asked,
    );
    expect(
      opinionKey('high', [
        issue('ค่าปรับไม่จำกัด', true),
        issue('กฎหมายต่างประเทศ', true),
      ]),
    ).not.toBe(asked);
  });

  it('a high level names what makes it high; every issue has a title and a level', () => {
    expect(riskProblems('high', [])).toEqual([
      'ความเสี่ยงสูงต้องระบุประเด็นที่ทำให้สูง',
    ]);
    expect(
      riskProblems('extreme', [
        { title: ' ', severity: 'huge', escalate: false },
      ]),
    ).toEqual([
      'ระดับความเสี่ยงไม่ถูกต้อง',
      'ประเด็นที่ 1: ต้องระบุประเด็น',
      'ประเด็นที่ 1: ระดับของประเด็นไม่ถูกต้อง',
    ]);
    expect(riskProblems('low', [])).toEqual([]);
  });

  it('ready to sign once the opinion needed is given in favour', () => {
    expect(signReadiness(false, 'not_needed').ready).toBeNull();
    expect(signReadiness(true, 'not_needed')).toEqual({
      ready: true,
      reason: null,
    });
    expect(signReadiness(true, 'approved').ready).toBe(true);
    for (const state of ['missing', 'draft', 'pending'] as const) {
      expect(signReadiness(true, state)).toEqual({
        ready: false,
        reason: 'ความเสี่ยงสูง — ต้องได้ความเห็นผู้บริหารก่อนลงนาม',
      });
    }
    expect(signReadiness(true, 'rejected').reason).toContain('ไม่เห็นชอบ');
  });
});

const legal = {
  userId: 'u-legal',
  activeCompanyId: 'osd',
  displayName: 'ฝ่ายกฎหมาย',
  permissions: ['legal.contract.read', 'legal.contract.manage'],
} as unknown as Principal;

function harness(options: {
  typeCode?: string | null;
  requestStatus?: string;
}) {
  let row: Record<string, unknown> | null = null;
  const assessments = {
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
    submit: jest.fn(() => Promise.resolve({})),
  };
  const service = new ContractRiskService(
    assessments as never,
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
    {} as never,
    {
      findFirst: jest.fn(() =>
        Promise.resolve({
          legalRiskOpinionTypeCode:
            options.typeCode === undefined ? 'LRO' : options.typeCode,
        }),
      ),
    } as never,
    {
      findFirst: jest.fn(() =>
        Promise.resolve({
          id: 'req-1',
          requestNo: 'LRO-001',
          status: options.requestStatus ?? 'pending_approval',
        }),
      ),
    } as never,
    requests as never,
    { record: jest.fn(() => Promise.resolve()) } as never,
  );
  return { service, requests, current: () => row };
}

describe('CD-158 ContractRiskService', () => {
  it('high risk asks the executives with the issues put to them; not ready to sign until they answer', async () => {
    const { service, requests } = harness({});
    const view = await service.save(
      { contractId: 'c-1' },
      {
        level: 'high',
        issues: [
          {
            title: 'ค่าปรับไม่มีเพดาน',
            clause: 'ข้อ 12',
            severity: 'high',
            escalate: true,
          },
          { title: 'ภาษาสัญญากำกวม', severity: 'low' },
        ],
      },
      legal,
      'Bearer t',
    );
    expect(requests.create).toHaveBeenCalledWith(
      expect.objectContaining({
        type_code: 'LRO',
        ref_type: 'contract',
        ref_id: 'CTR-001',
        form_data: expect.objectContaining({
          risk_level: 'สูง',
          // only the issue marked for them
          detail:
            'บริการดูแลระบบ — ความเสี่ยงสูง\n1. ค่าปรับไม่มีเพดาน (ข้อ 12)',
        }) as unknown,
      }),
      legal,
    );
    expect(requests.submit).toHaveBeenCalledWith('req-1', legal, 'Bearer t');
    expect(view.opinion.state).toBe('pending');
    expect(view.signing.ready).toBe(false);

    // saved again unchanged (a summary edit): nothing new is asked
    await service.save(
      { contractId: 'c-1' },
      {
        level: 'high',
        summary: 'ปรับถ้อยคำ',
        issues: [
          {
            title: 'ค่าปรับไม่มีเพดาน',
            severity: 'high',
            escalate: true,
          },
        ],
      },
      legal,
      'Bearer t',
    );
    expect(requests.create).toHaveBeenCalledTimes(1);
  });

  it('the opinion given in favour makes it ready; low risk is ready without asking', async () => {
    const given = harness({ requestStatus: 'approved' });
    const view = await given.service.save(
      { contractId: 'c-1' },
      { level: 'critical', issues: [{ title: 'x', severity: 'high' }] },
      legal,
      'Bearer t',
    );
    expect(view.signing).toEqual({ ready: true, reason: null });

    const low = harness({});
    const calm = await low.service.save(
      { contractId: 'c-1' },
      { level: 'low' },
      legal,
      'Bearer t',
    );
    expect(low.requests.create).not.toHaveBeenCalled();
    expect(calm.opinion.state).toBe('not_needed');
    expect(calm.signing.ready).toBe(true);
  });

  it('no request type set: kept as the reason, the assessment still saved', async () => {
    const { service, requests, current } = harness({ typeCode: null });
    const view = await service.save(
      { contractId: 'c-1' },
      { level: 'high', issues: [{ title: 'x', severity: 'high' }] },
      legal,
      'Bearer t',
    );
    expect(requests.create).not.toHaveBeenCalled();
    expect(current()).toMatchObject({ level: 'high' });
    expect(view.opinion.state).toBe('missing');
    expect(view.opinion.error).toContain('ยังไม่ได้ตั้งประเภทคำขอ');
  });

  it('asking again while a request is open is refused', async () => {
    const { service } = harness({});
    await service.save(
      { contractId: 'c-1' },
      { level: 'high', issues: [{ title: 'x', severity: 'high' }] },
      legal,
      'Bearer t',
    );
    await expect(
      service.requestOpinion({ contractId: 'c-1' }, legal, 'Bearer t'),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('a bad assessment is refused before anything is written', async () => {
    const { service, current } = harness({});
    await expect(
      service.save(
        { contractId: 'c-1' },
        { level: 'high', issues: [] },
        legal,
        'Bearer t',
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(current()).toBeNull();
  });
});
