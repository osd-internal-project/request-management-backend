import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { Permission } from '../policy/permissions';
import { ScopeLevel } from '../policy/scope';

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
 * Permissions and scopes are always **for the active company** (ROLE-04): the
 * same person can be a manager in one company and a plain employee in another.
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
  /** The caller's own org unit plus every unit beneath it (`OrgClosure`). */
  readonly teamOrgUnitIds: readonly string[];
  /** The caller's department subtree. */
  readonly departmentOrgUnitIds: readonly string[];

  readonly roles: readonly string[];
  readonly permissions: readonly Permission[];
  /** Resource name → scope level, e.g. `{ request: 'team' }`. */
  readonly scopes: Readonly<Record<string, ScopeLevel>>;
  /** Sensitive fields this caller may see unmasked (SCOPE-04). */
  readonly sensitiveFieldsVisible: readonly string[];

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

/** Scope for a resource, defaulting to the narrowest level if unconfigured. */
export function scopeFor(principal: Principal, resource: string): ScopeLevel {
  return principal.scopes[resource] ?? 'own';
}
