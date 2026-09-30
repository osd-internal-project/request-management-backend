import { Readable } from 'node:stream';
import type { Principal } from '@request-management/share';
import { SolutionsService } from './solutions.service';

const presales = {
  userId: 'ps-1',
  displayName: 'พรีเซลส์',
  activeCompanyId: 'osd',
  ledUnitIds: [],
  permissions: ['presales.solution.manage', 'presales.solution.read'],
} as unknown as Principal;
const sales = {
  userId: 'sales-1',
  displayName: 'เซลส์',
  activeCompanyId: 'osd',
  ledUnitIds: [],
  permissions: ['crm.sales.read'],
} as unknown as Principal;
const outsider = {
  ...sales,
  permissions: ['request.read'],
} as unknown as Principal;

const SOLUTION = {
  id: 'sol-1',
  companyId: 'osd',
  opportunityId: 'opp-1',
  requestId: 'req-1',
  title: 'SD-WAN',
  currentVersionNo: 1,
};
const version = (overrides: Record<string, unknown> = {}) => ({
  id: 'v-1',
  solutionId: 'sol-1',
  versionNo: 1,
  status: 'draft',
  summary: 'SD-WAN 12 สาขา',
  design: 'hub-spoke',
  assumptions: [],
  inScope: ['ติดตั้ง SD-WAN 12 สาขา'],
  outOfScope: [],
  deliverables: [{ title: 'ติดตั้ง', criteria: ['ลิงก์ขึ้นครบ'] }],
  boq: [
    {
      kind: 'equipment',
      productCode: 'FG-100F',
      name: 'FortiGate 100F',
      quantity: 12,
      unit: 'เครื่อง',
      refUnitCost: 45000,
    },
  ],
  feasibility: 'feasible',
  feasibilityNote: '',
  changeNote: null,
  ...overrides,
});

function harness(options: {
  request?: Record<string, unknown> | null;
  existing?: Record<string, unknown> | null;
  solution?: Record<string, unknown> | null;
  versions?: Record<string, unknown>[];
  dealVisible?: boolean;
  configType?: string | null;
  moved?: number;
  requirements?: Record<string, unknown>[];
  clarifications?: Record<string, unknown>[];
  risks?: Record<string, unknown>[];
  demos?: Record<string, unknown>[];
  torClauses?: Record<string, unknown>[];
  inactiveCode?: boolean;
}) {
  const versions = options.versions ?? [version()];
  const solutions = {
    findFirst: jest.fn((args: { where: Record<string, unknown> }) => {
      if ('requestId' in args.where) {
        return Promise.resolve(options.existing ?? null);
      }
      return Promise.resolve(
        options.solution === undefined ? SOLUTION : options.solution,
      );
    }),
    create: jest.fn(() => Promise.resolve({ id: 'sol-1' })),
    update: jest.fn(() => Promise.resolve({})),
    updateMany: jest.fn(() => Promise.resolve({ count: options.moved ?? 1 })),
    findMany: jest.fn(() => Promise.resolve([])),
  };
  const versionRepo = {
    findFirst: jest.fn((args: { where: { versionNo: number } }) =>
      Promise.resolve(
        versions.find((v) => v.versionNo === args.where.versionNo) ?? null,
      ),
    ),
    findMany: jest.fn(() => Promise.resolve(versions)),
    create: jest.fn(() => Promise.resolve({ id: 'v-2' })),
    updateMany: jest.fn(() => Promise.resolve({ count: options.moved ?? 1 })),
  };
  const files = {
    findMany: jest.fn(() => Promise.resolve([])),
    findFirst: jest.fn(() => Promise.resolve(null)),
    count: jest.fn(() => Promise.resolve(0)),
    create: jest.fn(() => Promise.resolve({})),
    createMany: jest.fn(() => Promise.resolve({ count: 0 })),
    update: jest.fn(() => Promise.resolve({})),
  };
  const torClauseRepo = {
    findMany: jest.fn(() => Promise.resolve(options.torClauses ?? [])),
  };
  const demoRepo = {
    findMany: jest.fn(() => Promise.resolve(options.demos ?? [])),
  };
  const riskRepo = {
    findMany: jest.fn(() => Promise.resolve(options.risks ?? [])),
  };
  const clarificationRepo = {
    findMany: jest.fn(() => Promise.resolve(options.clarifications ?? [])),
  };
  const requirementRepo = {
    findMany: jest.fn(() => Promise.resolve(options.requirements ?? [])),
  };
  const requests = {
    findFirst: jest.fn((args: { select: Record<string, unknown> }) =>
      Promise.resolve(
        'formData' in args.select
          ? {
              id: 'req-1',
              requestNo: 'SOL-1',
              status: 'in_progress',
              formData: {},
            }
          : options.request === undefined
            ? {
                id: 'req-1',
                requestNo: 'SOL-1',
                companyId: 'osd',
                typeCode: 'SOL',
                status: 'in_progress',
                refType: 'opportunity',
                refId: 'OPP-001',
              }
            : options.request,
      ),
    ),
  };
  const deal = {
    id: 'opp-1',
    companyId: 'osd',
    opportunityCode: 'OPP-001',
    title: 'SD-WAN',
    customerId: 'cus-1',
    prospectName: null,
    customer: { nameTh: 'ลูกค้า' },
  };
  const opportunities = {
    findFirst: jest.fn((args: { where: Record<string, unknown> }) =>
      Promise.resolve(
        'AND' in args.where && options.dealVisible === false ? null : deal,
      ),
    ),
  };
  const configs = {
    findFirst: jest.fn(() =>
      Promise.resolve({
        solutionRequestTypeCode:
          options.configType === undefined ? 'SOL' : options.configType,
      }),
    ),
  };
  const catalog = {
    assertCodes: jest.fn(() =>
      options.inactiveCode
        ? Promise.reject(
            Object.assign(new Error('x'), { code: 'VALIDATION_FAILED' }),
          )
        : Promise.resolve(),
    ),
  };
  const timeline = { publish: jest.fn(() => Promise.resolve()) };
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const storage = {
    put: jest.fn(() => Promise.resolve()),
    get: jest.fn(() => Promise.resolve(Readable.from(['x']))),
    remove: jest.fn(() => Promise.resolve()),
  };
  const service = new SolutionsService(
    solutions as never,
    versionRepo as never,
    files as never,
    requirementRepo as never,
    clarificationRepo as never,
    riskRepo as never,
    demoRepo as never,
    { findFirst: jest.fn(() => Promise.resolve(null)) } as never,
    { findMany: jest.fn(() => Promise.resolve([])) } as never,
    torClauseRepo as never,
    requests as never,
    opportunities as never,
    configs as never,
    catalog as never,
    timeline as never,
    audit as never,
    { execute: jest.fn((work: (p: unknown) => unknown) => work({})) } as never,
    storage,
  );
  return { service, solutions, versionRepo, files, audit, timeline, storage };
}

describe('CD-132 solutions', () => {
  it('CD-132: an accepted SOL request starts a Solution with a v1 draft on its deal', async () => {
    const { service, solutions, audit, timeline } = harness({});
    await service.start('req-1', presales);
    expect(solutions.create).toHaveBeenCalledWith(
      {
        data: expect.objectContaining({
          opportunityId: 'opp-1',
          requestId: 'req-1',
          title: 'SD-WAN',
          versions: { create: { versionNo: 1, createdBy: 'ps-1' } },
        }) as unknown,
      },
      { prisma: {} },
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'presales.solution.started' }),
      { prisma: {} },
    );
    expect(timeline.publish).toHaveBeenCalled();
  });

  it('starting twice returns the same Solution', async () => {
    const { service, solutions } = harness({ existing: { id: 'sol-1' } });
    const result = await service.start('req-1', presales);
    expect(solutions.create).not.toHaveBeenCalled();
    expect(result.id).toBe('sol-1');
  });

  it('only the configured SOL type, once accepted, may start one', async () => {
    await expect(
      harness({ configType: null }).service.start('req-1', presales),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      harness({
        request: {
          id: 'req-1',
          companyId: 'osd',
          typeCode: 'SOL',
          status: 'submitted',
          refType: 'opportunity',
          refId: 'OPP-001',
        },
      }).service.start('req-1', presales),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      harness({ request: null }).service.start('req-1', presales),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('SCOPE-03: a salesperson sees the Solution only on a deal they can see; others get 404', async () => {
    await expect(
      harness({}).service.findOne('sol-1', sales),
    ).resolves.toMatchObject({ id: 'sol-1', can_manage: false });
    await expect(
      harness({ dealVisible: false }).service.findOne('sol-1', sales),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      harness({}).service.findOne('sol-1', outsider),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('ROLE-01: a salesperson cannot edit the design', async () => {
    await expect(
      harness({}).service.updateDraft('sol-1', 1, { summary: 'x' }, sales),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('a draft saves cleaned assumptions; a bad one is refused', async () => {
    const { service, versionRepo } = harness({});
    await service.updateDraft(
      'sol-1',
      1,
      {
        assumptions: [
          { category: 'technical', text: ' วงจรหลัก 100 Mbps ' },
          { category: 'customer', text: '' },
        ],
      },
      presales,
    );
    expect(versionRepo.updateMany).toHaveBeenCalledWith(
      {
        where: { id: 'v-1', status: 'draft' },
        data: {
          assumptions: [{ category: 'technical', text: 'วงจรหลัก 100 Mbps' }],
          updatedBy: 'ps-1',
        },
      },
      { prisma: {} },
    );
    await expect(
      service.updateDraft(
        'sol-1',
        1,
        { assumptions: [{ category: 'nope' as never, text: 'x' }] },
        presales,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('a locked version is not edited', async () => {
    const { service } = harness({ versions: [version({ status: 'locked' })] });
    await expect(
      service.updateDraft('sol-1', 1, { summary: 'x' }, presales),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('locking needs a summary and a design, then supersedes the older locked version', async () => {
    await expect(
      harness({ versions: [version({ design: '' })] }).service.lock(
        'sol-1',
        1,
        presales,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    const { service, versionRepo, audit } = harness({
      solution: { ...SOLUTION, currentVersionNo: 2 },
      versions: [
        version({ versionNo: 2, id: 'v-2' }),
        version({ status: 'locked' }),
      ],
    });
    await service.lock('sol-1', 2, presales);
    expect(versionRepo.updateMany).toHaveBeenNthCalledWith(
      2,
      {
        where: { solutionId: 'sol-1', status: 'locked', versionNo: { lt: 2 } },
        data: { status: 'superseded', updatedBy: 'ps-1' },
      },
      { prisma: {} },
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'presales.solution.version_locked',
      }),
      { prisma: {} },
    );
  });

  it('CD-131: a version does not lock while the analysis is open', async () => {
    const { service } = harness({
      requirements: [
        { assessment: 'unassessed', customerAnswer: null },
        { assessment: 'needs_info', customerAnswer: null },
        { assessment: 'needs_info', customerAnswer: 'มี rack แล้ว' },
        { assessment: 'feasible', customerAnswer: null },
      ],
    });
    await expect(service.lock('sol-1', 1, presales)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [
        { field: 'version', reason: 'ยังไม่ได้ประเมินความต้องการ 1 ข้อ' },
        { field: 'version', reason: 'ยังรอลูกค้าตอบ 1 ข้อ' },
      ],
    });
  });

  it('CD-134: a version without a SOW does not lock', async () => {
    const { service } = harness({
      versions: [
        version({
          inScope: [],
          deliverables: [{ title: 'อบรม', criteria: [] }],
        }),
      ],
    });
    await expect(service.lock('sol-1', 1, presales)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [
        { field: 'version', reason: 'ยังไม่มีงานในขอบเขต' },
        { field: 'version', reason: 'รายการส่งมอบยังไม่มีเกณฑ์ตรวจรับ: อบรม' },
      ],
    });
  });

  it('CD-134: the SOW is saved cleaned with the draft', async () => {
    const { service, versionRepo } = harness({});
    await service.updateDraft(
      'sol-1',
      1,
      {
        in_scope: [' SD-WAN ', ''],
        out_of_scope: ['งานเดินสายภายในอาคาร'],
        deliverables: [{ title: 'ติดตั้ง', criteria: [' ลิงก์ขึ้น '] }],
      },
      presales,
    );
    expect(versionRepo.updateMany).toHaveBeenCalledWith(
      {
        where: { id: 'v-1', status: 'draft' },
        data: {
          inScope: ['SD-WAN'],
          outOfScope: ['งานเดินสายภายในอาคาร'],
          deliverables: [
            { title: 'ติดตั้ง', description: '', criteria: ['ลิงก์ขึ้น'] },
          ],
          updatedBy: 'ps-1',
        },
      },
      { prisma: {} },
    );
    await expect(
      service.updateDraft(
        'sol-1',
        1,
        { deliverables: [{ title: '', criteria: ['x'] }] },
        presales,
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [
        {
          field: 'deliverables',
          reason: 'รายการส่งมอบข้อ 1: ยังไม่มีชื่อรายการ',
        },
      ],
    });
  });

  it('CD-133: a version without a feasibility verdict does not lock', async () => {
    const { service } = harness({
      versions: [version({ feasibility: 'unassessed' })],
    });
    await expect(service.lock('sol-1', 1, presales)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [{ field: 'version', reason: 'ยังไม่ได้ประเมินความเป็นไปได้' }],
    });
  });

  it("CD-133: contract assumptions come from the deal's approved version; none, none", async () => {
    const approved = harness({});
    approved.versionRepo.findFirst.mockResolvedValueOnce({
      versionNo: 2,
      assumptions: [
        { category: 'third_party', text: 'ISP ส่งวงจร', owner: 'ISP' },
      ],
      feasibility: 'feasible',
      feasibilityNote: '',
      solution: { id: 'sol-1', title: 'SD-WAN' },
    });
    await expect(
      approved.service.contractAssumptions('OPP-001', sales),
    ).resolves.toEqual({
      solution: { id: 'sol-1', title: 'SD-WAN', versionNo: 2 },
      text: '1. [สิ่งที่ต้องพึ่งพาบุคคลที่สาม] ISP ส่งวงจร (ผู้รับผิดชอบ: ISP)',
    });

    const none = harness({});
    none.versionRepo.findFirst.mockResolvedValueOnce(null);
    await expect(
      none.service.contractAssumptions('OPP-001', sales),
    ).resolves.toEqual({ solution: null, text: null });

    await expect(
      harness({ dealVisible: false }).service.contractAssumptions(
        'OPP-001',
        sales,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('CD-135: a version locks only with a BOQ whose every line has a product code still sold', async () => {
    await expect(
      harness({ versions: [version({ boq: [] })] }).service.lock(
        'sol-1',
        1,
        presales,
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [{ field: 'version', reason: 'ยังไม่มีรายการใน BOQ' }],
    });
    await expect(
      harness({
        versions: [
          version({
            boq: [
              {
                kind: 'service',
                productCode: '',
                name: 'ติดตั้ง',
                quantity: 1,
              },
            ],
          }),
        ],
      }).service.lock('sol-1', 1, presales),
    ).rejects.toMatchObject({
      details: [
        { field: 'version', reason: 'BOQ บรรทัดที่ยังไม่มีรหัสสินค้า: 1' },
      ],
    });
    const inactive = harness({ inactiveCode: true });
    await expect(
      inactive.service.lock('sol-1', 1, presales),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(inactive.versionRepo.updateMany).not.toHaveBeenCalled();
  });

  it('a new version copies the locked one and needs the latest locked', async () => {
    await expect(
      harness({}).service.newVersion('sol-1', { change_note: 'x' }, presales),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const { service, versionRepo, files } = harness({
      versions: [
        version({
          status: 'locked',
          assumptions: [{ category: 'technical', text: 'a' }],
        }),
      ],
    });
    files.findMany.mockResolvedValueOnce([
      {
        companyId: 'osd',
        fileName: 'diagram.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 10,
        storageKey: 'solutions/sol-1/f/diagram.pdf',
        uploadedBy: 'ps-1',
        uploadedAt: new Date(),
      },
    ] as never);
    await service
      .newVersion('sol-1', { change_note: ' ลูกค้าเพิ่มสาขา ' }, presales)
      .catch(() => undefined);
    expect(versionRepo.create).toHaveBeenCalledWith(
      {
        data: expect.objectContaining({
          versionNo: 2,
          summary: 'SD-WAN 12 สาขา',
          assumptions: [{ category: 'technical', text: 'a' }],
          inScope: ['ติดตั้ง SD-WAN 12 สาขา'],
          deliverables: [
            { title: 'ติดตั้ง', description: '', criteria: ['ลิงก์ขึ้นครบ'] },
          ],
          changeNote: 'ลูกค้าเพิ่มสาขา',
        }) as unknown,
      },
      { prisma: {} },
    );
    expect(files.createMany).toHaveBeenCalledWith(
      {
        data: [
          expect.objectContaining({
            versionId: 'v-2',
            storageKey: 'solutions/sol-1/f/diagram.pdf',
          }),
        ],
      },
      { prisma: {} },
    );
  });

  it('a file is stored before its row, and the object is dropped if the row fails', async () => {
    const { service, storage, files } = harness({});
    files.create.mockRejectedValueOnce(new Error('db down'));
    await expect(
      service.uploadFile(
        'sol-1',
        1,
        {
          originalname: 'แบบ.pdf',
          mimetype: 'application/pdf',
          size: 5,
          buffer: Buffer.from('x'),
        },
        presales,
      ),
    ).rejects.toThrow('db down');
    const key = (storage.put.mock.calls[0] as unknown as [string])[0];
    expect(key).toMatch(/^solutions\/sol-1\/.+\/แบบ\.pdf$/);
    expect(storage.remove).toHaveBeenCalledWith(key);
  });
});
