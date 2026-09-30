import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError, PolicyGuard, setPrincipal } from '@request-management/share';
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
        {
          company: { id: 'osd', name: 'OSD', docPrefix: 'OSD' },
          isPrimary: true,
        },
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

describe('internal/principal/resolve-by-email — through the real PolicyGuard', () => {
  const handler: unknown = Reflect.get(
    InternalPrincipalController.prototype,
    'resolveByEmail',
  );

  function contextFor(principal: Principal): ExecutionContext {
    const request: Record<string, unknown> = { headers: {} };
    setPrincipal(request as never, principal);
    return {
      getHandler: () => handler,
      getClass: () => InternalPrincipalController,
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
  }

  async function serviceAccount(username: string, keyScopes: string[]) {
    const { service } = serviceForMachine();
    return service.resolve(
      {
        sub: 'svc-1',
        preferred_username: username,
        client_id: username.replace('service-account-', ''),
      },
      undefined,
      keyScopes,
    );
  }

  function serviceForMachine() {
    const config = { get: () => 'request-form' };
    const service = new PrincipalService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      config as never,
    );
    return { service };
  }

  const guard = new PolicyGuard(new Reflector());

  function errorOf(run: () => unknown): unknown {
    try {
      run();
    } catch (error) {
      return error;
    }
    return undefined;
  }

  it('lets the integration client in when its API key holds integration.request.create', async () => {
    const principal = await serviceAccount('service-account-request-form', [
      'integration.request.create',
    ]);

    expect(guard.canActivate(contextFor(principal))).toBe(true);
  });

  it('refuses the integration client when its API key lacks the scope', async () => {
    const principal = await serviceAccount('service-account-request-form', [
      'integration.crm.lead.create',
    ]);

    expect(
      errorOf(() => guard.canActivate(contextFor(principal))),
    ).toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('ignores forwarded scopes on another project’s service account', async () => {
    const principal = await serviceAccount('service-account-librechat', [
      'integration.request.create',
    ]);

    expect(principal.permissions).toEqual([]);
    expect(() => guard.canActivate(contextFor(principal))).toThrow(AppError);
  });

  it('refuses a person even if they hold the permission', () => {
    const person = {
      userId: 'u-1',
      isServiceAccount: false,
      permissions: ['integration.request.create'],
    } as unknown as Principal;

    expect(() => guard.canActivate(contextFor(person))).toThrow(AppError);
  });
});
