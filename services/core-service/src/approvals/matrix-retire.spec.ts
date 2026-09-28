import type { Principal } from '@request-management/share';
import { ApprovalMatrixRepository } from './approval-matrix.repository';
import { ApprovalMatrixService } from './approval-matrix.service';

const OSD = 'company-osd';
const admin = {
  userId: 'admin',
  activeCompanyId: OSD,
  companies: [{ id: OSD, name: 'OSD', docPrefix: 'OSD', isPrimary: true }],
  permissions: ['admin.approval-matrix.manage'],
} as unknown as Principal;

const v1 = {
  id: 'm-1',
  version: 1,
  currency: 'THB',
  retired: false,
  levels: [{ type: 'supervisor', up: 1 }],
};

describe('CD-80 retiring an approval ladder', () => {
  function repositoryOver(latest: Record<string, unknown> | null) {
    const prisma = {
      approvalMatrix: { findFirst: jest.fn(() => Promise.resolve(latest)) },
    };
    return new ApprovalMatrixRepository(prisma as never);
  }

  it('CD-80: a retired latest version means no ladder — not the version before it', async () => {
    const repository = repositoryOver({ ...v1, version: 2, retired: true });
    await expect(
      repository.findEffective(OSD, 'request:DSC', new Date()),
    ).resolves.toBeNull();
  });

  it('an ordinary latest version is returned as before', async () => {
    const repository = repositoryOver(v1);
    await expect(
      repository.findEffective(OSD, 'request:DSC', new Date()),
    ).resolves.toMatchObject({ id: 'm-1' });
  });

  function serviceOver(current: Record<string, unknown> | null) {
    const matrices = {
      findEffective: jest.fn(() => Promise.resolve(current)),
      latestVersion: jest.fn(() => Promise.resolve(1)),
      create: jest.fn((args: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'm-2', ...args.data }),
      ),
    };
    const audit = { record: jest.fn(() => Promise.resolve()) };
    const service = new ApprovalMatrixService(
      matrices as never,
      {} as never,
      audit as never,
    );
    return { service, matrices, audit };
  }

  it('CD-80: retiring publishes a new version marked retired and audits what it ended', async () => {
    const { service, matrices, audit } = serviceOver(v1);

    const retired = await service.retire(
      { company_id: OSD, subject_type: 'request:DSC' },
      admin,
    );

    expect(retired).toMatchObject({ version: 2, retired: true, levels: [] });
    expect(matrices.create).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'approval.matrix.retired',
        before: expect.objectContaining({ version: 1 }) as unknown,
      }),
    );
  });

  it('nothing in force to retire is refused rather than stacking tombstones', async () => {
    const { service, matrices } = serviceOver(null);
    await expect(
      service.retire({ company_id: OSD, subject_type: 'request:DSC' }, admin),
    ).rejects.toThrow('ไม่มีตารางอำนาจอนุมัติที่ใช้อยู่');
    expect(matrices.create).not.toHaveBeenCalled();
  });

  it('SCOPE-03: another company is refused', async () => {
    const { service } = serviceOver(v1);
    await expect(
      service.retire(
        { company_id: 'company-other', subject_type: 'request:DSC' },
        admin,
      ),
    ).rejects.toThrow();
  });
});
