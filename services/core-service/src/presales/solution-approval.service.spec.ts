import type { Principal } from '@request-management/share';
import { SolutionApprovalService } from './solution-approval.service';

const presales = {
  userId: 'ps-1',
  activeCompanyId: 'osd',
  permissions: ['presales.solution.manage'],
} as unknown as Principal;

const LOCKED = {
  id: 'v-2',
  versionNo: 2,
  status: 'locked',
  summary: 'SD-WAN 12 สาขา',
  inScope: ['ติดตั้ง SD-WAN'],
  outOfScope: [],
  deliverables: [{ title: 'ติดตั้ง', criteria: ['ลิงก์ขึ้นครบ'] }],
  assumptions: [],
  approvalStatus: 'none',
  approvalRequestId: null,
};

function harness(
  options: {
    version?: Record<string, unknown> | null;
    typeCode?: string | null;
    pending?: Record<string, unknown> | null;
    moved?: number;
    clarifications?: Record<string, unknown>[];
    risks?: Record<string, unknown>[];
    demos?: Record<string, unknown>[];
    torClauses?: Record<string, unknown>[];
  } = {},
) {
  const solutions = {
    requireManageable: jest.fn(() =>
      Promise.resolve({
        id: 'sol-1',
        companyId: 'osd',
        opportunityId: 'opp-1',
        title: 'SD-WAN',
        currentVersionNo: 2,
      }),
    ),
    activeRequirements: jest.fn(() => Promise.resolve([])),
    activeClarifications: jest.fn(() =>
      Promise.resolve(options.clarifications ?? []),
    ),
    activeRisks: jest.fn(() => Promise.resolve(options.risks ?? [])),
    activeDemos: jest.fn(() => Promise.resolve(options.demos ?? [])),
    activeTor: jest.fn(() =>
      Promise.resolve({
        facts: null,
        files: [],
        clauses: options.torClauses ?? [],
      }),
    ),
  };
  const versions = {
    findFirst: jest.fn((args: { where: Record<string, unknown> }) =>
      Promise.resolve(
        'approvalRequestId' in args.where
          ? (options.pending ?? null)
          : options.version === undefined
            ? LOCKED
            : options.version,
      ),
    ),
    updateMany: jest.fn(() => Promise.resolve({ count: options.moved ?? 1 })),
  };
  const requests = {
    create: jest.fn(() => Promise.resolve({ id: 'req-9', requestNo: null })),
  };
  const configs = {
    findFirst: jest.fn(() =>
      Promise.resolve({
        solutionApprovalTypeCode:
          options.typeCode === undefined ? 'SOLA' : options.typeCode,
      }),
    ),
  };
  const opportunities = {
    findFirst: jest.fn(() =>
      Promise.resolve({
        id: 'opp-1',
        companyId: 'osd',
        opportunityCode: 'OPP-001',
        customerId: 'cus-1',
      }),
    ),
  };
  const events = { on: jest.fn() };
  const timeline = { publish: jest.fn(() => Promise.resolve()) };
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const service = new SolutionApprovalService(
    solutions as never,
    versions as never,
    requests as never,
    configs as never,
    opportunities as never,
    events as never,
    timeline as never,
    audit as never,
    { execute: jest.fn((work: (p: unknown) => unknown) => work({})) } as never,
  );
  return { service, versions, requests, audit, timeline, events };
}

const firstArg = (mock: jest.Mock) =>
  (mock.mock.calls[0] as unknown as [Record<string, unknown>])[0];

describe('CD-143 solution approval', () => {
  it('CD-143: a locked version raises a draft request on the deal, prefilled, and goes pending', async () => {
    const { service, requests, versions, audit } = harness();
    await expect(
      service.requestApproval('sol-1', 2, presales),
    ).resolves.toEqual({ request_id: 'req-9', request_no: null });
    expect(firstArg(requests.create)).toMatchObject({
      type_code: 'SOLA',
      ref_type: 'opportunity',
      ref_id: 'OPP-001',
      form_data: {
        solution_title: 'SD-WAN',
        version_no: '2',
        in_scope: '1. ติดตั้ง SD-WAN',
        deliverables: '1. ติดตั้ง\n   - ตรวจรับ: ลิงก์ขึ้นครบ',
      },
    });
    expect(firstArg(versions.updateMany)).toMatchObject({
      data: { approvalStatus: 'pending', approvalRequestId: 'req-9' },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'presales.solution.approval_requested',
      }),
      { prisma: {} },
    );
  });

  it('a draft, an older version, a pending or an approved one is refused', async () => {
    for (const version of [
      { ...LOCKED, status: 'draft' },
      { ...LOCKED, approvalStatus: 'pending' },
      { ...LOCKED, approvalStatus: 'approved' },
    ]) {
      const { service, requests } = harness({ version });
      await expect(
        service.requestApproval('sol-1', 2, presales),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(requests.create).not.toHaveBeenCalled();
    }
    const older = harness({ version: { ...LOCKED, versionNo: 1 } });
    await expect(
      older.service.requestApproval('sol-1', 1, presales),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('CD-140: an answer that changed the scope blocks approval until the SOW has it', async () => {
    const { service, requests } = harness({
      clarifications: [
        {
          answer: 'เพิ่มสาขาที่ 13',
          affectsScope: true,
          scopeResolvedVersionNo: null,
        },
      ],
    });
    await expect(
      service.requestApproval('sol-1', 2, presales),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(requests.create).not.toHaveBeenCalled();
  });

  it('CD-141: an open high risk without a plan blocks approval', async () => {
    const { service, requests } = harness({
      risks: [
        {
          seq: 1,
          title: 'อุปกรณ์ขาดตลาด',
          likelihood: 4,
          impact: 4,
          owner: 'จัดซื้อ',
          mitigation: '',
          status: 'open',
        },
      ],
    });
    await expect(
      service.requestApproval('sol-1', 2, presales),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(requests.create).not.toHaveBeenCalled();
  });

  it('CD-139: a demo finding the Solution must change for blocks approval until a version has it', async () => {
    const { service, requests } = harness({
      demos: [
        {
          status: 'done',
          equipment: [],
          findings: [{ requiresChange: true, resolvedVersionNo: null }],
        },
      ],
    });
    await expect(
      service.requestApproval('sol-1', 2, presales),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(requests.create).not.toHaveBeenCalled();
  });

  it('CD-138: a mandatory TOR clause unanswered or not complied blocks approval', async () => {
    const { service, requests } = harness({
      torClauses: [
        { mandatory: true, compliance: 'comply' },
        { mandatory: true, compliance: 'not_comply' },
      ],
    });
    await expect(
      service.requestApproval('sol-1', 2, presales),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(requests.create).not.toHaveBeenCalled();
  });

  it('a rejected version may be asked again', async () => {
    const { service, requests } = harness({
      version: { ...LOCKED, approvalStatus: 'rejected' },
    });
    await service.requestApproval('sol-1', 2, presales);
    expect(requests.create).toHaveBeenCalled();
  });

  it('without the type in the CRM settings nothing is raised', async () => {
    const { service, requests } = harness({ typeCode: null });
    await expect(
      service.requestApproval('sol-1', 2, presales),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(requests.create).not.toHaveBeenCalled();
  });

  it('CD-143: the approved request marks its version approved and tells the customer timeline', async () => {
    const { service, versions, timeline } = harness({
      pending: {
        id: 'v-2',
        versionNo: 2,
        solution: {
          id: 'sol-1',
          companyId: 'osd',
          opportunity: {
            id: 'opp-1',
            opportunityCode: 'OPP-001',
            customerId: 'cus-1',
          },
        },
      },
    });
    await service.onRequestOutcome(
      {
        request_id: 'req-9',
        request_no: 'SOLA-1',
        type_code: 'SOLA',
        requester_id: 'ps-1',
      } as never,
      'approved',
    );
    expect(firstArg(versions.updateMany)).toMatchObject({
      where: { approvalRequestId: 'req-9', approvalStatus: 'pending' },
      data: { approvalStatus: 'approved' },
    });
    expect(timeline.publish).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'opportunity.solution_approved' }),
      { prisma: {} },
    );
  });

  it('an outcome for a request that is not ours changes nothing', async () => {
    const { service, versions } = harness({ pending: null });
    await service.onRequestOutcome(
      { request_id: 'other' } as never,
      'rejected',
    );
    expect(versions.updateMany).not.toHaveBeenCalled();
  });
});
