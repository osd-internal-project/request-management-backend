import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  AppError,
  AUTHENTICATED_KEY,
  PERMISSIONS_KEY,
  SERVICE_ACCOUNT_ONLY_KEY,
  PolicyGuard,
  Principal,
  PUBLIC_KEY,
  setPrincipal,
} from '@request-management/share';

function principalWith(
  permissions: string[],
  isServiceAccount = false,
): Principal {
  return {
    userId: 'u_1',
    keycloakId: 'kc_1',
    username: 'somchai.k',
    displayName: 'สมชาย ก.',
    email: 'somchai.k@company.co.th',
    companies: [],
    activeCompanyId: 'c_osd',
    orgUnitId: 'ou_team',
    supervisorUserId: 'u_lead',
    teamOrgUnitIds: [],
    departmentOrgUnitIds: [],
    roles: [],
    permissions: permissions as Principal['permissions'],
    scopes: {},
    sensitiveFieldsVisible: [],
    sensitiveFieldsAll: [],
    isServiceAccount,
    pendingOrgAssignment: false,
  };
}

function contextFor(principal?: Principal): ExecutionContext {
  const request: Record<string, unknown> = { headers: {} };
  if (principal) setPrincipal(request as never, principal);

  return {
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

/** Stubs the metadata an endpoint's decorators would have set. */
function reflectorReturning(metadata: Record<string, unknown>): Reflector {
  return {
    getAllAndOverride: (key: string) => metadata[key],
  } as unknown as Reflector;
}

describe('ROLE-01 PolicyGuard', () => {
  it('allows a caller holding every declared permission', () => {
    const guard = new PolicyGuard(
      reflectorReturning({ [PERMISSIONS_KEY]: ['admin.role.manage'] }),
    );

    expect(
      guard.canActivate(contextFor(principalWith(['admin.role.manage']))),
    ).toBe(true);
  });

  it('403s when a declared permission is missing, naming it in details', () => {
    const guard = new PolicyGuard(
      reflectorReturning({ [PERMISSIONS_KEY]: ['admin.role.manage'] }),
    );

    expect.assertions(3);
    try {
      guard.canActivate(contextFor(principalWith(['request.read'])));
    } catch (error) {
      const appError = error as AppError;
      expect(appError.code).toBe('FORBIDDEN');
      expect(appError.httpStatus).toBe(403);
      expect(appError.details[0].reason).toBe('admin.role.manage');
    }
  });

  it('401s when no principal was resolved', () => {
    const guard = new PolicyGuard(
      reflectorReturning({ [PERMISSIONS_KEY]: ['request.read'] }),
    );

    expect(() => guard.canActivate(contextFor())).toThrow(
      expect.objectContaining({ code: 'UNAUTHORIZED' }),
    );
  });

  it('lets @Public() through without a principal', () => {
    const guard = new PolicyGuard(reflectorReturning({ [PUBLIC_KEY]: true }));

    expect(guard.canActivate(contextFor())).toBe(true);
  });

  it('lets @Authenticated() through for any signed-in caller', () => {
    const guard = new PolicyGuard(
      reflectorReturning({ [AUTHENTICATED_KEY]: true }),
    );

    expect(guard.canActivate(contextFor(principalWith([])))).toBe(true);
  });

  /**
   * The rule that makes ROLE-01 hold in practice: forgetting to annotate a new
   * endpoint has to fail, because an endpoint that is quietly open is exactly
   * the failure nobody notices until it matters.
   */
  it('denies an endpoint that declares no access policy at all', () => {
    const guard = new PolicyGuard(reflectorReturning({}));

    expect(() => guard.canActivate(contextFor(principalWith([])))).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
  });
});

/**
 * AUTH-06 — the flag used to be computed and never enforced, so a machine
 * credential could drive the admin screens and a person could post as an
 * integration.
 */
describe('AUTH-06 service-account boundary', () => {
  const integration = {
    [PERMISSIONS_KEY]: ['integration.request.create'],
    [SERVICE_ACCOUNT_ONLY_KEY]: true,
  };

  it('lets a service account call an integration endpoint', () => {
    const guard = new PolicyGuard(reflectorReturning(integration));
    const principal = principalWith(['integration.request.create'], true);

    expect(guard.canActivate(contextFor(principal))).toBe(true);
  });

  it('refuses a person on an integration endpoint', () => {
    const guard = new PolicyGuard(reflectorReturning(integration));
    const principal = principalWith(['integration.request.create'], false);

    expect(() => guard.canActivate(contextFor(principal))).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
  });

  it('refuses a service account everywhere else, even with the permission', () => {
    const guard = new PolicyGuard(
      reflectorReturning({ [PERMISSIONS_KEY]: ['admin.role.manage'] }),
    );
    const principal = principalWith(['admin.role.manage'], true);

    expect(() => guard.canActivate(contextFor(principal))).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
  });
});
