import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { PolicyGuard } from './policy.guard';
import {
  ANY_PERMISSION_KEY,
  AUTHENTICATED_KEY,
  PERMISSIONS_KEY,
  PUBLIC_KEY,
} from './policy.decorators';
import type { AppError } from '../errors/app-error';
import type { Principal } from '../context/principal';

/** The metadata a controller would have declared, keyed as the guard reads it. */
type Declared = Partial<Record<string, unknown>>;

function guardFor(declared: Declared, permissions: string[]) {
  const reflector = {
    getAllAndOverride: (key: string) => declared[key],
  } as unknown as Reflector;

  const principal = {
    userId: 'user-1',
    activeCompanyId: 'company-osd',
    permissions,
    isServiceAccount: false,
  } as unknown as Principal;

  const context = {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => ({ principal }) }),
  } as unknown as ExecutionContext;

  return () => new PolicyGuard(reflector).canActivate(context);
}

/**
 * ROLE-01 — the guard is the control, and it is deny-by-default.
 *
 * `route-guards.spec.ts` proves every route *declares* something; this proves
 * what each declaration then means.
 */
describe('PolicyGuard decides what a declaration means', () => {
  it('requires all of an all-of declaration', () => {
    const both = { [PERMISSIONS_KEY]: ['user.read', 'admin.org.manage'] };

    expect(guardFor(both, ['user.read', 'admin.org.manage'])()).toBe(true);
    expect(guardFor(both, ['user.read'])).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
  });

  it('refuses a route that declares no policy at all', () => {
    expect(guardFor({}, ['user.read'])).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
  });

  it('lets `@Public()` and `@Authenticated()` through', () => {
    expect(guardFor({ [PUBLIC_KEY]: true }, [])()).toBe(true);
    expect(guardFor({ [AUTHENTICATED_KEY]: true }, [])()).toBe(true);
  });
});

/**
 * The company directory is read by two different jobs — an administrator
 * managing people (`user.read`) and a requester naming a receiver
 * (`request.create`, §16 หน้าที่ 3). Requiring both locked out whichever one
 * you were not, which is how a plain `employee` met 403 on the only screen
 * they use.
 */
describe('AnyPermission accepts any one of the listed permissions', () => {
  const directory = {
    [ANY_PERMISSION_KEY]: ['user.read', 'request.create'],
  };

  it('admits the administrator', () => {
    expect(guardFor(directory, ['user.read'])()).toBe(true);
  });

  it('admits the requester', () => {
    expect(guardFor(directory, ['request.create'])()).toBe(true);
  });

  it('admits somebody holding both', () => {
    expect(guardFor(directory, ['user.read', 'request.create'])()).toBe(true);
  });

  it('refuses somebody holding neither', () => {
    expect(guardFor(directory, ['notification.read'])).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
  });

  /**
   * The message names what would have been enough. Listing what the caller
   * lacks — the all-of wording — reads as though every one were required,
   * which is the opposite of the rule being applied.
   */
  it('says which permissions would have sufficed', () => {
    expect.assertions(1);

    try {
      guardFor(directory, [])();
    } catch (error) {
      expect((error as AppError).details).toEqual([
        {
          field: 'permission',
          reason: 'ต้องมีอย่างใดอย่างหนึ่ง: user.read, request.create',
        },
      ]);
    }
  });

  /** An all-of declaration wins: a route never means both things at once. */
  it('is not consulted when the route declares an all-of rule', () => {
    const both = {
      [PERMISSIONS_KEY]: ['admin.org.manage'],
      [ANY_PERMISSION_KEY]: ['request.create'],
    };

    expect(guardFor(both, ['request.create'])).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
  });
});
