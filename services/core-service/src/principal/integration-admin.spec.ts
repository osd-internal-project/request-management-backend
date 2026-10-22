import { isPermission, permissionType } from '@request-management/share';
import { INTEGRATION_PRESETS } from './integration-presets';
import type { Principal } from '@request-management/share';
import { IntegrationAdminService } from './integration-admin.service';

/** ระบบภายนอก 1 แถว: ผูกบริษัทของผู้ดูแลเสมอ และ X-Acting-User ปิดเป็นค่าเริ่มต้น. */
describe('IntegrationAdminService', () => {
  function admin(companyId = 'osd'): Principal {
    return {
      userId: 'admin-1',
      activeCompanyId: companyId,
      permissions: ['admin.integration.manage'],
    } as unknown as Principal;
  }

  function harness(existing?: Record<string, unknown>) {
    const row = (data: Record<string, unknown>) => ({
      id: 'int-1',
      companyId: 'osd',
      description: null,
      modes: ['app', 'delegated'],
      allowActingUser: false,
      keycloakClientIds: [],
      active: true,
      createdAt: new Date('2026-10-22T09:00:00.000Z'),
      createdBy: 'admin-1',
      _count: { apiKeys: 0, webhooks: 0 },
      ...data,
    });
    const integrations = {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn((args: { where: { companyId: string } }) =>
        Promise.resolve(
          existing && args.where.companyId === 'osd' ? row(existing) : null,
        ),
      ),
      create: jest.fn((args: { data: Record<string, unknown> }) =>
        Promise.resolve(row(args.data)),
      ),
      update: jest.fn((args: { data: Record<string, unknown> }) =>
        Promise.resolve(row({ ...existing, ...args.data })),
      ),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const calls = {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'call-1',
          apiKeyId: 'key-1',
          method: 'GET',
          route: '/api/v1/requests/:id',
          mode: 'user_token',
          actorUserId: 'u-1',
          status: 200,
          durationMs: 12,
          createdAt: new Date('2026-10-22T10:00:00.000Z'),
        },
      ]),
      count: jest.fn().mockResolvedValue(1),
    };
    return {
      service: new IntegrationAdminService(
        integrations as never,
        audit as never,
        calls as never,
      ),
      integrations,
      audit,
      calls,
    };
  }

  it('pins the company to the admin and leaves X-Acting-User off', async () => {
    const { service, integrations } = harness();

    const out = await service.create(
      {
        name: ' Aiyara ',
        modes: ['delegated', 'delegated'],
        company_id: 'other',
      } as never,
      admin('osd-demo'),
    );

    const data = (
      integrations.create.mock.calls[0] as [{ data: Record<string, unknown> }]
    )[0].data;
    expect(data).toMatchObject({
      companyId: 'osd-demo',
      name: 'Aiyara',
      modes: ['delegated'],
      allowActingUser: false,
      keycloakClientIds: [],
    });
    expect(out.allow_acting_user).toBe(false);
  });

  it('another company’s integration answers 404', async () => {
    const { service, integrations } = harness({ name: 'x' });

    await expect(
      service.update('int-1', { active: false }, admin('osd-demo')),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(integrations.update).not.toHaveBeenCalled();
  });

  it('audits what changed, before and after', async () => {
    const { service, audit } = harness({ name: 'Aiyara' });

    await service.update(
      'int-1',
      { allow_acting_user: true, keycloak_client_ids: ['aiyara-web'] },
      admin(),
    );

    const entry = (
      audit.record.mock.calls[0] as [
        { eventType: string; before: unknown; after: unknown },
      ]
    )[0];
    expect(entry.eventType).toBe('admin.integration.updated');
    expect(entry.before).toMatchObject({ allowActingUser: false });
    expect(entry.after).toMatchObject({
      allowActingUser: true,
      keycloakClientIds: ['aiyara-web'],
    });
  });

  it('lists an integration’s calls, newest first, as route templates', async () => {
    const { service, calls } = harness({ name: 'Aiyara' });

    const out = await service.listCalls(
      'int-1',
      { page: 1, page_size: 20 },
      admin(),
    );

    expect(calls.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { integrationId: 'int-1' },
        orderBy: { createdAt: 'desc' },
      }),
    );
    expect(out.data).toEqual([
      {
        id: 'call-1',
        at: '2026-10-22T10:00:00.000Z',
        method: 'GET',
        route: '/api/v1/requests/:id',
        mode: 'user_token',
        api_key_id: 'key-1',
        actor_user_id: 'u-1',
        status: 200,
        duration_ms: 12,
      },
    ]);
  });

  it('another company’s integration answers 404 and reads no calls (SCOPE-03)', async () => {
    const { service, calls } = harness({ name: 'Aiyara' });

    await expect(
      service.listCalls('int-1', { page: 1, page_size: 20 }, admin('other')),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(calls.findMany).not.toHaveBeenCalled();
  });
});

describe('INTEGRATION_PRESETS', () => {
  it('ticks only machine scopes that exist in the catalog', () => {
    const scopes = INTEGRATION_PRESETS.flatMap((preset) => preset.scopes);

    expect(scopes.filter((scope) => !isPermission(scope))).toEqual([]);
    expect(
      scopes.filter((scope) => permissionType(scope) !== 'service'),
    ).toEqual([]);
  });
});
