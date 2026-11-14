import type { Principal } from '@request-management/share';
import { RolesService } from './roles.service';

const ADMIN = {
  userId: 'admin-1',
  username: 'admin',
  activeCompanyId: 'osd',
  companies: [{ id: 'osd' }],
  permissions: ['admin.role.manage'],
  isServiceAccount: false,
} as unknown as Principal;

function build(options: { held: string[]; revokedCount?: number }) {
  const overrides = {
    listLive: jest.fn().mockResolvedValue([]),
    closeLive: jest.fn().mockResolvedValue({ count: 0 }),
    insert: jest.fn((data: { reason: string }) =>
      Promise.resolve({ id: 'o1', ...data }),
    ),
    revoke: jest.fn().mockResolvedValue({ count: options.revokedCount ?? 1 }),
  };
  const service = new RolesService(
    {} as never,
    {
      findForUserInCompany: jest
        .fn()
        .mockResolvedValue([
          {
            role: {
              permissions: options.held.map((permissionCode) => ({
                permissionCode,
              })),
            },
          },
        ]),
    } as never,
    {} as never,
    {} as never,
    { record: jest.fn().mockResolvedValue(undefined) } as never,
    { execute: (work: (client: unknown) => unknown) => work({}) } as never,
    { companyIdsOf: jest.fn().mockResolvedValue(['osd']) } as never,
    overrides as never,
  );
  return { service, overrides };
}

describe('P7 — per-person overrides', () => {
  it('a GRANT that would break §5.4 on the combined set is refused (422)', async () => {
    const { service, overrides } = build({ held: ['admin.org.manage'] });

    await expect(
      service.createOverride(
        'user-1',
        {
          permission_code: 'approval.decide',
          effect: 'GRANT',
          reason: 'ทดสอบ',
        },
        ADMIN,
      ),
    ).rejects.toMatchObject({ code: 'UNPROCESSABLE' });
    expect(overrides.insert).not.toHaveBeenCalled();
  });

  it('a system.* code is refused for a company override (422)', async () => {
    const { service } = build({ held: [] });

    await expect(
      service.createOverride(
        'user-1',
        { permission_code: 'system.user.read', effect: 'GRANT', reason: 'x' },
        ADMIN,
      ),
    ).rejects.toMatchObject({ code: 'UNPROCESSABLE' });
  });

  it('replaces the live row for the same code, pinned to the active company', async () => {
    const { service, overrides } = build({ held: [] });

    await service.createOverride(
      'user-1',
      {
        permission_code: 'crm.quotation.approve',
        effect: 'GRANT',
        reason: ' ช่วงปิดงบ ',
      },
      ADMIN,
    );

    const where = {
      userId: 'user-1',
      companyId: 'osd',
      permissionCode: 'crm.quotation.approve',
    };
    expect(overrides.closeLive).toHaveBeenCalledWith(
      where,
      'admin-1',
      expect.anything(),
    );
    expect(overrides.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        ...where,
        effect: 'GRANT',
        reason: 'ช่วงปิดงบ',
      }),
      expect.anything(),
    );
  });

  it('revoking a row of another company answers 404', async () => {
    const { service, overrides } = build({ held: [], revokedCount: 0 });

    await expect(
      service.revokeOverride('user-1', 'o-other', ADMIN),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(overrides.revoke).toHaveBeenCalledWith(
      'o-other',
      { userId: 'user-1', companyId: 'osd' },
      'admin-1',
      expect.anything(),
    );
  });
});
