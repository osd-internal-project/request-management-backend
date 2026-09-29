import { HandoverTechnicalService } from './handover-technical.service';

function harness(options: {
  any?: boolean;
  approved?: Record<string, unknown> | null;
  version?: Record<string, unknown> | null;
}) {
  const versions = {
    findFirst: jest.fn((args: { where: Record<string, unknown> }) => {
      if ('id' in args.where) return Promise.resolve(options.version ?? null);
      if ('approvalStatus' in args.where) {
        return Promise.resolve(options.approved ?? null);
      }
      return Promise.resolve(options.any ? { id: 'v-1' } : null);
    }),
  };
  const requirements = {
    findMany: jest.fn(() =>
      Promise.resolve([{ seq: 1, kind: 'technical', text: 'firewall' }]),
    ),
  };
  const files = {
    findMany: jest.fn(() => Promise.resolve([{ id: 'f-1' }])),
    findFirst: jest.fn(() => Promise.resolve({ fileName: 'แบบ.pdf' })),
  };
  const service = new HandoverTechnicalService(
    versions as never,
    requirements as never,
    files as never,
  );
  return { service, versions, files };
}

describe('CD-144 handover technical package', () => {
  it('CD-144: the candidate is the latest approved version of the deal', async () => {
    const { service, versions } = harness({
      any: true,
      approved: { id: 'v-3', versionNo: 3, solution: { title: 'SD-WAN' } },
    });
    await expect(service.candidate('opp-1')).resolves.toEqual({
      hasSolution: true,
      version: { id: 'v-3', versionNo: 3, title: 'SD-WAN' },
    });
    expect(versions.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          solution: { opportunityId: 'opp-1' },
          approvalStatus: 'approved',
        },
        orderBy: { approvedAt: 'desc' },
      }),
    );
  });

  it('a deal without Pre-Sales work has no candidate and needs none', async () => {
    await expect(harness({}).service.candidate('opp-1')).resolves.toEqual({
      hasSolution: false,
      version: null,
    });
  });

  it('the package reads the version whole, stored JSON read defensively', async () => {
    const { service } = harness({
      version: {
        id: 'v-3',
        solutionId: 'sol-1',
        versionNo: 3,
        summary: 'สรุป',
        design: 'แบบ',
        assumptions: 'junk',
        inScope: ['ติดตั้ง', ''],
        outOfScope: null,
        deliverables: [{ title: 'ติดตั้ง', criteria: ['ลิงก์ขึ้น'] }],
        approvedAt: null,
        solution: { id: 'sol-1', title: 'SD-WAN' },
      },
    });
    await expect(service.packageOf('v-3')).resolves.toMatchObject({
      title: 'SD-WAN',
      versionNo: 3,
      inScope: ['ติดตั้ง'],
      outOfScope: [],
      assumptions: [],
      deliverables: [
        { title: 'ติดตั้ง', description: '', criteria: ['ลิงก์ขึ้น'] },
      ],
      requirements: [{ seq: 1 }],
      files: [{ id: 'f-1' }],
    });
    await expect(service.packageOf(null)).resolves.toBeNull();
  });

  it('a file is found only within the attached version', async () => {
    const { service, files } = harness({});
    await service.fileOf('v-3', 'f-1');
    expect(files.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'f-1', versionId: 'v-3', deletedAt: null },
      }),
    );
    await expect(service.fileOf(null, 'f-1')).resolves.toBeNull();
  });
});
