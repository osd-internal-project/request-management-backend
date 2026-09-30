import { AppError } from '@request-management/share';
import type { Principal } from '@request-management/share';
import type { KeycloakJwtPayload } from '../auth/strategies/jwt.strategy';
import { InternalPrincipalController } from './principal.controller';
import { PrincipalService } from './principal.service';

/**
 * Keycloak is login only (29 Sep 2026): roles on the token grant nothing, for
 * people or machines. The shared `OSD` realm carries role names that belong to
 * other projects, so reading them here would hand out this app's permissions.
 */
describe('Keycloak login only — token roles grant nothing', () => {
  const USER = {
    id: 'u-1',
    keycloakId: 'kc-1',
    username: 'somchai',
    displayName: 'Somchai',
    email: 'somchai@osd.co.th',
    orgUnitId: 'unit-1',
    supervisorUserId: null,
    lastCompanyId: null,
    primaryCompanyId: 'osd',
    keycloakRoles: ['admin'],
  };

  /*
    `roles` exposes only `rolesForUser`: any attempt to derive grants from token
    roles (a mapping sync) throws here and fails the test.
  */
  function serviceWith(manualRoles: unknown[] = []) {
    const users = {
      upsertFromClaims: jest.fn().mockResolvedValue(USER),
      findActiveByEmail: jest.fn().mockResolvedValue(USER),
    };
    const org = {
      companiesForUser: jest.fn().mockResolvedValue([
        { company: { id: 'osd', name: 'OSD', docPrefix: 'OSD' }, isPrimary: true },
      ]),
      ledUnitIdsOf: jest.fn().mockResolvedValue([]),
      levelUnitIdsOf: jest.fn().mockResolvedValue([]),
      scopedAccessOf: jest.fn().mockResolvedValue({
        readUnits: [],
        actUnits: [],
        readUsers: [],
        actUsers: [],
        byPermission: {},
      }),
    };
    const roles = {
      rolesForUser: jest.fn().mockResolvedValue(manualRoles),
    };
    const policy = {
      resolveVisibleSensitiveFields: jest.fn().mockResolvedValue([]),
      listAllSensitiveFieldKeys: jest.fn().mockResolvedValue([]),
    };
    const config = { get: () => 'request-form' };

    const service = new PrincipalService(
      users as never,
      org as never,
      roles as never,
      policy as never,
      config as never,
    );

    return { service, roles };
  }

  it('gives a service account no permissions even when its client holds the role', async () => {
    const { service } = serviceWith();
    const payload = {
      sub: 'svc-1',
      preferred_username: 'service-account-request-form',
      client_id: 'request-form',
      realm_access: { roles: ['admin'] },
      resource_access: {
        'request-form': { roles: ['integration.request.create'] },
      },
    } as unknown as KeycloakJwtPayload;

    const principal = await service.resolve(payload);

    expect(principal.isServiceAccount).toBe(true);
    expect(principal.permissions).toEqual([]);
  });

  it('gives a person only their in-app grants, ignoring realm roles on the token', async () => {
    const { service, roles } = serviceWith();
    const payload = {
      sub: 'kc-1',
      preferred_username: 'somchai',
      realm_access: { roles: ['admin', 'integration.request.create'] },
    } as unknown as KeycloakJwtPayload;

    const principal = await service.resolve(payload);

    expect(roles.rolesForUser).toHaveBeenCalledWith('u-1', 'osd');
    expect(principal.roles).toEqual([]);
    expect(principal.permissions).toEqual([]);
  });

  it('resolves an acting user by email from in-app grants only', async () => {
    const { service } = serviceWith();

    const principal = await service.resolveByEmail('somchai@osd.co.th');

    expect(principal.permissions).toEqual([]);
  });
});

describe('internal/principal/resolve-by-email — only the integration client', () => {
  function controllerFor() {
    const principals = {
      resolveByEmail: jest.fn().mockResolvedValue({ userId: 'u-1' }),
    };
    const config = { get: () => 'request-form' };
    const controller = new InternalPrincipalController(
      principals as never,
      config as never,
    );
    return { controller, principals };
  }

  const caller = (username: string) =>
    ({ username, isServiceAccount: true, permissions: [] }) as unknown as Principal;

  it('lets this app’s service account look a person up without any token role', async () => {
    const { controller, principals } = controllerFor();

    await controller.resolveByEmail(
      caller('service-account-request-form'),
      'somchai@osd.co.th',
    );

    expect(principals.resolveByEmail).toHaveBeenCalledWith(
      'somchai@osd.co.th',
      undefined,
    );
  });

  it('refuses another project’s service account in the shared realm', () => {
    const { controller, principals } = controllerFor();

    expect(() =>
      controller.resolveByEmail(
        caller('service-account-librechat'),
        'somchai@osd.co.th',
      ),
    ).toThrow(AppError);
    expect(principals.resolveByEmail).not.toHaveBeenCalled();
  });
});
