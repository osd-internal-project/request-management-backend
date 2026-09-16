import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { ActingPolicyGuard } from './acting-policy.guard';
import { ACTING_PERMISSIONS_KEY } from './policy.decorators';
import type { Principal } from '../context/principal';

function guardFor(
  declared: Record<string, unknown>,
  principal: Partial<Principal> | undefined,
) {
  const reflector = {
    getAllAndOverride: (key: string) => declared[key],
  } as unknown as Reflector;

  const context = {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => ({ principal }) }),
  } as unknown as ExecutionContext;

  return () => new ActingPolicyGuard(reflector).canActivate(context);
}

/** A person, i.e. what the request looks like after the acting-user swap. */
function person(permissions: string[]): Partial<Principal> {
  return {
    userId: 'user-1',
    activeCompanyId: 'company-osd',
    permissions,
    isServiceAccount: false,
  } as Partial<Principal>;
}

/** The credential that arrived, i.e. what it looks like if the swap is missing. */
function robot(permissions: string[]): Partial<Principal> {
  return {
    activeCompanyId: 'company-osd',
    permissions,
    isServiceAccount: true,
  } as Partial<Principal>;
}

/**
 * The second gate. `PolicyGuard` judges the credential; this judges the person
 * it is acting for, and before it existed nothing did (see the guard's own
 * doc comment for why the request API got away with it and CRM would not).
 */
describe('ActingPolicyGuard judges the person, not the credential', () => {
  const manage = { [ACTING_PERMISSIONS_KEY]: ['crm.customer.manage'] };

  it('admits a person holding every declared permission', () => {
    expect(guardFor(manage, person(['crm.customer.manage']))()).toBe(true);
  });

  it('refuses a person missing one, naming it', () => {
    expect(guardFor(manage, person(['crm.customer.read']))).toThrow(
      expect.objectContaining({
        code: 'FORBIDDEN',
        details: [{ field: 'permission', reason: 'crm.customer.manage' }],
      }),
    );
  });

  it('requires all of an all-of declaration', () => {
    const both = {
      [ACTING_PERMISSIONS_KEY]: ['crm.customer.read', 'crm.customer.manage'],
    };

    expect(guardFor(both, person(['crm.customer.read']))).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
  });

  /*
    A route acting as the robot itself — lead intake, an approval case opened
    by another module. There is no person to judge, and `PolicyGuard` has
    already had the only say there is.
  */
  it('stands aside on a route that declares nothing', () => {
    expect(guardFor({}, robot(['integration.crm.lead.create']))()).toBe(true);
  });

  /*
    The failure mode this guard has to survive: somebody declares
    `@ActingPermissions` but forgets `ActingUserGuard`, or writes the two in
    the wrong order. The principal is then still the service account, whose
    `integration.*` scopes never include a human permission — so the route
    answers 403 instead of silently skipping the check.
  */
  it('fails closed when the swap never happened', () => {
    expect(
      guardFor(manage, robot(['integration.crm.customer.manage'])),
    ).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
  });

  it('answers UNAUTHORIZED when no principal was resolved at all', () => {
    expect(guardFor(manage, undefined)).toThrow(
      expect.objectContaining({ code: 'UNAUTHORIZED' }),
    );
  });
});
