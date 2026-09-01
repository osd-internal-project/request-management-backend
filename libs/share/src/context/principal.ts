import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { Permission } from '../policy/permissions';
import type { AccessSubject } from '../access/access-rules';

/** One company the caller belongs to (AUTH-05). */
export interface PrincipalCompany {
  readonly id: string;
  readonly name: string;
  readonly docPrefix: string;
  readonly isPrimary: boolean;
}

/**
 * The caller, fully resolved for the active company.
 *
 * Built once per request: `user-service` reads it from its own tables,
 * `core-service` fetches it from `GET /internal/policy/resolve` and caches it
 * for the access token's lifetime. Everything downstream — guards, scope
 * filters, masking — reads this and nothing else.
 *
 * Permissions are always **for the active company** (ROLE-04): the same person
 * can be a manager in one company and a plain employee in another, and
 * `ledUnitIds` is likewise the groups they lead *in that company*.
 */
export interface Principal {
  readonly userId: string;
  readonly keycloakId: string;
  readonly username: string;
  readonly displayName: string;
  readonly email: string | null;

  readonly companies: readonly PrincipalCompany[];
  /**
   * Empty only for a freshly provisioned user with no company membership yet
   * — see {@link Principal.pendingOrgAssignment}.
   */
  readonly activeCompanyId: string;

  readonly orgUnitId: string | null;
  readonly supervisorUserId: string | null;
  /**
   * Every group this caller leads, plus every group beneath those.
   *
   * Resolved once here from `OrgClosure` rather than per query: it is read by
   * every request list, and walking the chart on each one is what the closure
   * table exists to avoid (§6.2's note, which outlived the scope levels).
   */
  readonly ledUnitIds: readonly string[];

  readonly roles: readonly string[];
  readonly permissions: readonly Permission[];
  /** Sensitive fields this caller may see unmasked (SCOPE-04). */
  readonly sensitiveFieldsVisible: readonly string[];
  /**
   * Every field declared sensitive, as `resource.field`.
   *
   * The interceptor masks `sensitiveFieldsAll − sensitiveFieldsVisible`. Both
   * lists are needed: knowing only what a caller *may* see cannot tell you
   * what to hide, since an ordinary field would then look like a withheld one.
   */
  readonly sensitiveFieldsAll: readonly string[];

  /** True when the caller is a service account rather than a person. */
  readonly isServiceAccount: boolean;

  /**
   * AUTH-04: the user has signed in but an admin has not placed them in the
   * org chart yet. They hold no permissions and appear in the
   * "รอจัดสังกัด" queue; the frontend shows the waiting state rather than an
   * empty dashboard.
   */
  readonly pendingOrgAssignment: boolean;
}

/** Where the principal lives on the Express request. */
export const PRINCIPAL_KEY = 'principal' as const;

export interface RequestWithPrincipal extends Request {
  [PRINCIPAL_KEY]?: Principal;
}

export function getPrincipal(
  request: RequestWithPrincipal,
): Principal | undefined {
  return request[PRINCIPAL_KEY];
}

export function setPrincipal(
  request: RequestWithPrincipal,
  principal: Principal,
): void {
  request[PRINCIPAL_KEY] = principal;
}

/** Injects the resolved {@link Principal} into a controller handler. */
export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Principal | undefined =>
    getPrincipal(context.switchToHttp().getRequest<RequestWithPrincipal>()),
);

export function hasPermission(
  principal: Principal,
  permission: Permission,
): boolean {
  return principal.permissions.includes(permission);
}

/**
 * The facts {@link visibleRequestsWhere} and friends need, read off a
 * principal. One conversion in one place, so no caller assembles it by hand
 * and quietly leaves a field out.
 */
export function accessSubject(principal: Principal): AccessSubject {
  return {
    userId: principal.userId,
    activeCompanyId: principal.activeCompanyId,
    ledUnitIds: principal.ledUnitIds,
    readsWholeCompany: hasPermission(principal, 'request.read.all'),
  };
}
