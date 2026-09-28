import { Prisma } from '@prisma/client';
import type { Principal } from '@request-management/share';
import { ApprovalMatrixService } from './approval-matrix.service';

const OSD = 'company-osd';

function admin(): Principal {
  return {
    userId: 'user-admin',
    activeCompanyId: OSD,
    companies: [{ id: OSD }],
    permissions: ['admin.approval-matrix.manage'],
    // Only the fields these paths read.
  } as unknown as Principal;
}

function collision() {
  return new Prisma.PrismaClientKnownRequestError('unique', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

function serviceWith(create: jest.Mock) {
  let latest = 2;
  return new ApprovalMatrixService(
    {
      latestVersion: jest.fn(() => Promise.resolve(latest++)),
      create,
    } as never,
    { assertLevelTargetsExist: jest.fn(() => Promise.resolve()) } as never,
    { record: jest.fn(() => Promise.resolve()) } as never,
  );
}

const DTO = {
  subject_type: 'request:IT',
  levels: [{ type: 'supervisor', up: 1 }],
};

describe('APV-01: two admins publishing the same ladder at once', () => {
  it('recounts and takes the next number when the first attempt collides', async () => {
    const create = jest
      .fn()
      .mockRejectedValueOnce(collision())
      .mockImplementation(({ data }: { data: { version: number } }) =>
        Promise.resolve({ id: 'm-1', ...data }),
      );

    const published = await serviceWith(create).publish(DTO as never, admin());

    expect(published.version).toBe(4);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('does not swallow an error that is not a collision', async () => {
    const create = jest.fn().mockRejectedValue(new Error('db down'));

    await expect(
      serviceWith(create).publish(DTO as never, admin()),
    ).rejects.toThrow('db down');
    expect(create).toHaveBeenCalledTimes(1);
  });
});
