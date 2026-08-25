import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Permission,
  Principal,
  PrincipalCompany,
} from '@request-management/share';
import type { User } from '@prisma/client';
import { OrgService } from '../org/org.service';
import { PolicyService } from '../policy/policy.service';
import { RolesService } from '../roles/roles.service';
import { UsersRepository } from '../users/users.repository';
import { KeycloakJwtPayload } from '../auth/strategies/jwt.strategy';

/**
 * Pulls the realm and client roles out of a verified token. Per D-07 these
 * come from Keycloak, never from LDAP groups.
 */
export function keycloakRolesOf(
  payload: KeycloakJwtPayload,
  clientId: string,
): string[] {
  const realmRoles = payload.realm_access?.roles ?? [];
  const clientRoles = payload.resource_access?.[clientId]?.roles ?? [];

  return [...new Set([...realmRoles, ...clientRoles])];
}

function displayNameOf(payload: KeycloakJwtPayload): string {
  const name = payload['name'];
  if (typeof name === 'string' && name.trim()) return name;

  const given = payload['given_name'];
  const family = payload['family_name'];
  const composed = [given, family].filter((part) => typeof part === 'string');
  if (composed.length) return composed.join(' ');

  return payload.preferred_username;
}

/**
 * Turns a verified Keycloak token into the {@link Principal} everything
 * downstream reads.
 *
 * This runs on **every request**, which is deliberate: ROLE-03 requires a role
 * revoked in Keycloak to lose its effect within one access-token lifetime, and
 * SCOPE-01 requires a scope change from the admin screen to apply without a
 * deploy. Caching the answer for longer than the token would break both.
 */
@Injectable()
export class PrincipalService {
  constructor(
    private readonly users: UsersRepository,
    private readonly org: OrgService,
    private readonly roles: RolesService,
    private readonly policy: PolicyService,
    private readonly config: ConfigService,
  ) {}

  async resolve(
    payload: KeycloakJwtPayload,
    requestedCompanyId?: string,
  ): Promise<Principal> {
    // Resolved before provisioning so the roles can be cached on the profile:
    // screen A3 shows "role จาก Keycloak: …" for users who have not been
    // assigned yet, and that must work without an Admin API call.
    const keycloakRoles = keycloakRolesOf(
      payload,
      this.config.get<string>('keycloak.clientId') ?? '',
    );

    // A machine credential is not a person: provisioning one would add it to
    // the users table and the "รอจัดสังกัด" queue, where an admin would be
    // invited to assign a team to a robot.
    if (this.isServiceAccount(payload)) {
      return this.serviceAccountPrincipal(payload);
    }

    const user = await this.provision(payload, keycloakRoles);

    const memberships = await this.org.companiesForUser(user.id);
    const companies: PrincipalCompany[] = memberships.map((membership) => ({
      id: membership.company.id,
      name: membership.company.name,
      docPrefix: membership.company.docPrefix,
      isPrimary: membership.isPrimary,
    }));

    const activeCompanyId = this.pickActiveCompany(
      companies,
      requestedCompanyId,
      user.primaryCompanyId,
    );

    // No company yet means nothing to resolve roles against. Return a
    // principal that can read /auth/me and nothing else, so the frontend can
    // render the "waiting for assignment" state instead of a broken shell.
    if (!activeCompanyId) {
      return this.pendingPrincipal(user, payload, companies);
    }

    await this.roles.syncFromKeycloakRoles(
      user.id,
      activeCompanyId,
      keycloakRoles,
    );

    const userRoles = await this.roles.rolesForUser(user.id, activeCompanyId);
    const roleIds = userRoles.map((userRole) => userRole.roleId);
    const permissions = RolesService.permissionsOf(userRoles);

    const [scopes, sensitiveFieldsVisible, sensitiveFieldsAll, scopeSets] =
      await Promise.all([
        this.policy.resolveScopes(roleIds),
        this.policy.resolveVisibleSensitiveFields(permissions),
        this.policy.listAllSensitiveFieldKeys(),
        this.org.scopeSetsFor(user),
      ]);

    return {
      userId: user.id,
      keycloakId: user.keycloakId,
      username: user.username,
      displayName: user.displayName,
      email: user.email,
      companies,
      activeCompanyId,
      orgUnitId: user.orgUnitId,
      supervisorUserId: user.supervisorUserId,
      teamOrgUnitIds: scopeSets.teamOrgUnitIds,
      departmentOrgUnitIds: scopeSets.departmentOrgUnitIds,
      roles: userRoles.map((userRole) => userRole.role.code),
      permissions,
      scopes: scopes,
      sensitiveFieldsVisible,
      sensitiveFieldsAll,
      isServiceAccount: this.isServiceAccount(payload),
      pendingOrgAssignment: user.orgUnitId === null,
    };
  }

  /** AUTH-04: create the local profile on first login, from token claims only. */
  private provision(
    payload: KeycloakJwtPayload,
    keycloakRoles: readonly string[],
  ): Promise<User> {
    return this.users.upsertFromClaims({
      keycloakRoles,
      keycloakId: payload.sub,
      username: payload.preferred_username,
      email: payload.email ?? null,
      displayName: displayNameOf(payload),
      firstName:
        typeof payload['given_name'] === 'string'
          ? payload['given_name']
          : null,
      lastName:
        typeof payload['family_name'] === 'string'
          ? payload['family_name']
          : null,
    });
  }

  private pickActiveCompany(
    companies: readonly PrincipalCompany[],
    requested: string | undefined,
    primaryCompanyId: string | null,
  ): string | null {
    if (requested && companies.some((company) => company.id === requested)) {
      return requested;
    }

    if (
      primaryCompanyId &&
      companies.some((company) => company.id === primaryCompanyId)
    ) {
      return primaryCompanyId;
    }

    return (
      companies.find((company) => company.isPrimary)?.id ??
      companies[0]?.id ??
      null
    );
  }

  private pendingPrincipal(
    user: User,
    payload: KeycloakJwtPayload,
    companies: readonly PrincipalCompany[],
  ): Principal {
    return {
      userId: user.id,
      keycloakId: user.keycloakId,
      username: user.username,
      displayName: user.displayName,
      email: user.email,
      companies,
      activeCompanyId: '',
      orgUnitId: user.orgUnitId,
      supervisorUserId: user.supervisorUserId,
      teamOrgUnitIds: [],
      departmentOrgUnitIds: [],
      roles: [],
      permissions: [] as Permission[],
      scopes: {},
      sensitiveFieldsVisible: [],
      sensitiveFieldsAll: [],
      isServiceAccount: this.isServiceAccount(payload),
      pendingOrgAssignment: true,
    };
  }

  /**
   * A principal for a machine credential — no local profile, no company.
   *
   * Permissions come from the client's own realm roles rather than a company
   * role binding, because a service account has no org placement to resolve
   * against. `PolicyGuard` additionally confines it to `@ServiceAccountOnly()`
   * endpoints.
   */
  private serviceAccountPrincipal(payload: KeycloakJwtPayload): Principal {
    const username = payload.preferred_username ?? 'service-account';

    return {
      userId: payload.sub,
      keycloakId: payload.sub,
      username,
      displayName: username,
      email: null,
      companies: [],
      activeCompanyId: '',
      orgUnitId: null,
      supervisorUserId: null,
      teamOrgUnitIds: [],
      departmentOrgUnitIds: [],
      roles: [],
      permissions: keycloakRolesOf(
        payload,
        typeof payload['client_id'] === 'string' ? payload['client_id'] : '',
      ) as Principal['permissions'],
      scopes: {},
      sensitiveFieldsVisible: [],
      sensitiveFieldsAll: [],
      isServiceAccount: true,
      pendingOrgAssignment: false,
    };
  }

  /**
   * AUTH-06: is this a client-credentials token rather than a person?
   *
   * Keycloak emits the claim as `client_id` (snake_case) and names the
   * principal `service-account-<clientId>`. An earlier version checked a
   * camelCase `clientId` that Keycloak never sends, so this always returned
   * false and the service-account boundary was never actually enforced —
   * requests were only refused later, by the permission check, which happened
   * to 403 for unrelated reasons.
   */
  private isServiceAccount(payload: KeycloakJwtPayload): boolean {
    const username = payload.preferred_username ?? '';
    return (
      typeof payload['client_id'] === 'string' ||
      username.startsWith('service-account-')
    );
  }
}
