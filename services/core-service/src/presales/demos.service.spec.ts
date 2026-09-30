import type { Principal } from '@request-management/share';
import { DemosService } from './demos.service';

const presales = {
  userId: 'ps-1',
  activeCompanyId: 'osd',
  permissions: ['presales.solution.manage'],
} as unknown as Principal;
const seller = {
  userId: 'sales-1',
  activeCompanyId: 'osd',
  permissions: ['crm.sales.read', 'crm.sales.manage'],
} as unknown as Principal;

const SOLUTION = {
  id: 'sol-1',
  companyId: 'osd',
  opportunityId: 'opp-1',
  currentVersionNo: 2,
};
const DEMO = {
  id: 'd-1',
  solutionId: 'sol-1',
  status: 'planned',
  title: 'POC',
  criteria: [{ text: 'failover', result: 'met', note: '' }],
  outcome: 'ผ่าน',
};

function harness(
  options: {
    demo?: Record<string, unknown> | null;
    equipment?: Record<string, unknown>[];
    item?: Record<string, unknown> | null;
    finding?: Record<string, unknown> | null;
    version?: Record<string, unknown> | null;
    request?: Record<string, unknown> | null;
    usedRequest?: boolean;
  } = {},
) {
  const manage = (actor: Principal) =>
    actor.permissions.includes('presales.solution.manage');
  const solutions = {
    requireManageable: jest.fn((_: string, actor: Principal) =>
      manage(actor)
        ? Promise.resolve(SOLUTION)
        : Promise.reject(Object.assign(new Error('x'), { code: 'FORBIDDEN' })),
    ),
    requireReadable: jest.fn(() => Promise.resolve(SOLUTION)),
    findOne: jest.fn(() => Promise.resolve({ id: 'sol-1' })),
  };
  const demos = {
    findFirst: jest.fn(
      (args: { where: Record<string, unknown>; select?: unknown }) => {
        if ('requestId' in args.where) {
          return Promise.resolve(options.usedRequest ? { id: 'd-0' } : null);
        }
        if (args.select) return Promise.resolve({ seq: 2 });
        return Promise.resolve(
          options.demo === undefined ? DEMO : options.demo,
        );
      },
    ),
    create: jest.fn(() => Promise.resolve({ id: 'd-9', seq: 3 })),
    update: jest.fn(() => Promise.resolve({})),
    updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
  };
  const equipment = {
    findMany: jest.fn(() => Promise.resolve(options.equipment ?? [])),
    findFirst: jest.fn(() => Promise.resolve(options.item ?? null)),
    create: jest.fn(() => Promise.resolve({ id: 'e-1' })),
    update: jest.fn(() => Promise.resolve({})),
    count: jest.fn(() =>
      Promise.resolve(
        (options.equipment ?? []).filter((row) => !row.returnedOn).length,
      ),
    ),
  };
  const findings = {
    findFirst: jest.fn((args: { select?: unknown }) =>
      Promise.resolve(args.select ? { seq: 1 } : (options.finding ?? null)),
    ),
    create: jest.fn(() => Promise.resolve({ id: 'f-9' })),
    update: jest.fn(() => Promise.resolve({})),
  };
  const versions = {
    findFirst: jest.fn(() => Promise.resolve(options.version ?? null)),
  };
  const requests = {
    findFirst: jest.fn(() =>
      Promise.resolve(
        options.request === undefined
          ? {
              typeCode: 'DEMO',
              refType: 'opportunity',
              refId: 'OPP-001',
              status: 'in_progress',
              formData: {
                kind: 'POC',
                objective: 'POC SD-WAN 2 สาขา\nรายละเอียด',
                proposed_date: '2026-10-05',
                site: 'สำนักงานใหญ่ลูกค้า',
                success_criteria: '1. failover < 30s\n2. ผ่าน firewall เดิม',
              },
            }
          : options.request,
      ),
    ),
    findMany: jest.fn(() => Promise.resolve([])),
  };
  const opportunities = {
    findFirst: jest.fn(() => Promise.resolve({ opportunityCode: 'OPP-001' })),
  };
  const configs = {
    findFirst: jest.fn(() => Promise.resolve({ demoRequestTypeCode: 'DEMO' })),
  };
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const service = new DemosService(
    solutions as never,
    demos as never,
    equipment as never,
    findings as never,
    versions as never,
    requests as never,
    opportunities as never,
    configs as never,
    audit as never,
    { execute: jest.fn((work: (p: unknown) => unknown) => work({})) } as never,
  );
  return { service, demos, equipment, findings, audit };
}

const dataOf = (mock: jest.Mock) =>
  (mock.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0]
    .data;

describe('CD-139 Demo / POC', () => {
  it("CD-139: a demo starts from the deal's Demo/POC request, prefilled", async () => {
    const { service, demos } = harness({ demo: null });
    await service.create('sol-1', { request_id: 'req-7' }, presales);
    expect(dataOf(demos.create)).toMatchObject({
      seq: 3,
      requestId: 'req-7',
      kind: 'poc',
      title: 'POC SD-WAN 2 สาขา',
      scheduledOn: new Date('2026-10-05T00:00:00Z'),
      site: 'สำนักงานใหญ่ลูกค้า',
      criteria: [
        { text: 'failover < 30s', result: 'pending', note: '' },
        { text: 'ผ่าน firewall เดิม', result: 'pending', note: '' },
      ],
    });
  });

  it('a request of another deal, another type, or one used already is refused', async () => {
    await expect(
      harness({
        request: { typeCode: 'DEMO', refType: 'opportunity', refId: 'OPP-999' },
      }).service.create('sol-1', { request_id: 'req-7' }, presales),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      harness({
        request: { typeCode: 'SOL', refType: 'opportunity', refId: 'OPP-001' },
      }).service.create('sol-1', { request_id: 'req-7' }, presales),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      harness({ usedRequest: true }).service.create(
        'sol-1',
        { request_id: 'req-7' },
        presales,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('CD-139: a demo does not close with equipment still out', async () => {
    const { service, demos } = harness({
      equipment: [{ name: 'FortiGate 100F', returnedOn: null }],
    });
    await expect(
      service.close('sol-1', 'd-1', { status: 'done' }, presales),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(demos.updateMany).not.toHaveBeenCalled();

    const back = harness({
      equipment: [{ name: 'FortiGate 100F', returnedOn: new Date() }],
    });
    await back.service.close('sol-1', 'd-1', { status: 'done' }, presales);
    expect(back.demos.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'd-1', status: 'planned' },
        data: expect.objectContaining({ status: 'done' }) as unknown,
      }),
      { prisma: {} },
    );
  });

  it('equipment goes out and comes back, never before it left', async () => {
    const { service, equipment } = harness();
    await service.checkOut(
      'sol-1',
      'd-1',
      {
        name: ' FortiGate 100F ',
        serial: 'FG1',
        quantity: 2,
        out_on: '2026-10-01',
      },
      presales,
    );
    expect(dataOf(equipment.create)).toMatchObject({
      name: 'FortiGate 100F',
      quantity: 2,
      outOn: new Date('2026-10-01T00:00:00Z'),
    });

    const item = {
      name: 'FortiGate',
      outOn: new Date('2026-10-05T00:00:00Z'),
      returnedOn: null,
    };
    await expect(
      harness({ item }).service.checkIn(
        'sol-1',
        'd-1',
        'e-1',
        { returned_on: '2026-10-04' },
        presales,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const ok = harness({ item });
    await ok.service.checkIn(
      'sol-1',
      'd-1',
      'e-1',
      { returned_on: '2026-10-06' },
      presales,
    );
    expect(dataOf(ok.equipment.update)).toMatchObject({
      returnedOn: new Date('2026-10-06T00:00:00Z'),
    });
  });

  it('a finding needing a change closes only on a version edited after it', async () => {
    const finding = {
      requiresChange: true,
      resolvedVersionNo: null,
      recordedOnVersionNo: 2,
      createdAt: new Date('2026-10-06T10:00:00Z'),
    };
    await expect(
      harness({
        finding,
        version: {
          versionNo: 2,
          status: 'locked',
          lockedAt: new Date('2026-10-01T00:00:00Z'),
        },
      }).service.resolveFinding(
        'sol-1',
        'd-1',
        'f-1',
        { version_no: 2 },
        presales,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const ok = harness({
      finding,
      version: { versionNo: 3, status: 'draft', lockedAt: null },
    });
    await ok.service.resolveFinding(
      'sol-1',
      'd-1',
      'f-1',
      { version_no: 3 },
      presales,
    );
    expect(dataOf(ok.findings.update)).toMatchObject({ resolvedVersionNo: 3 });
  });

  it('ROLE-01: sales read demos but do not write them', async () => {
    await expect(
      harness().service.create('sol-1', {}, seller),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
