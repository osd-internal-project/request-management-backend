import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AppError,
  isPermission,
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
import { pickActiveCompany } from './active-company';

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
 * This runs on **every request**, which is deliberate: SCOPE-01 requires a
 * grant or scope change from the admin screen to apply without a deploy.
 * Keycloak roles on the token grant nothing — AGENTS.md "Identity and Keycloak".
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
    keyScopes: readonly string[] = [],
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
      return this.serviceAccountPrincipal(payload, keyScopes);
    }

    const user = await this.provision(payload, keycloakRoles);

    return this.principalFor(user, requestedCompanyId);
  }

  /**
   * จำบริษัทที่ผู้ใช้เพิ่งสลับไป เพื่อให้ login ครั้งถัดไปเข้าที่เดิม (AUTH-05).
   *
   * เขียนจาก `POST /auth/switch-company` เท่านั้น ไม่ใช่จาก `resolve()` ซึ่งทำงานทุก
   * request — การเขียนตรงนั้นคือ write หนึ่งครั้งต่อการเรียก API ทุกครั้ง เพื่อบันทึก
   * ค่าที่แทบไม่เคยเปลี่ยน
   */
  async rememberActiveCompany(
    userId: string,
    companyId: string,
  ): Promise<void> {
    await this.users.update({
      where: { id: userId },
      data: { lastCompanyId: companyId },
    });
  }

  /**
   * The principal for somebody identified by **email** rather than by a token.
   *
   * For `core-service`'s external API: a chatbot holds one service-account
   * credential and names the person it is acting for, so that every rule
   * downstream — row visibility, `assertMayAct`, the SLA clock, who the
   * timeline says did it — applies to the human, not to the robot. Without
   * this the alternatives are both worse: let the robot act with its own
   * authority over everyone's work, or re-implement each of those rules for
   * one caller.
   *
   * Roles are the person's grants in this app, exactly as on the token path.
   *
   * Nobody is provisioned from here. A profile is created from a token on
   * first login (AUTH-04); inventing one from an email would let anything that
   * can reach this endpoint mint an identity.
   */
  async resolveByEmail(
    email: string,
    requestedCompanyId?: string,
  ): Promise<Principal> {
    const user = await this.users.findActiveByEmail(email);

    if (!user) {
      throw new AppError(
        'NOT_FOUND',
        'ไม่พบผู้ใช้ที่ระบุ หรือผู้ใช้ยังไม่เคยเข้าสู่ระบบ',
        [{ field: 'email', reason: email }],
      );
    }

    return this.principalFor(user, requestedCompanyId);
  }

  /**
   * Everything a principal is, once the `User` row is in hand.
   *
   * Shared by the token path and the email path so the two cannot drift. A
   * second copy would be a second answer to "what may this person do", and the
   * copy reached through an integration is exactly the one nobody would test.
   */
  private async principalFor(
    user: User,
    requestedCompanyId?: string,
  ): Promise<Principal> {
    const memberships = await this.org.companiesForUser(user.id);
    const companies: PrincipalCompany[] = memberships.map((membership) => ({
      id: membership.company.id,
      name: membership.company.name,
      docPrefix: membership.company.docPrefix,
      isPrimary: membership.isPrimary,
    }));

    const activeCompanyId = pickActiveCompany(
      companies,
      requestedCompanyId,
      user.lastCompanyId,
      user.primaryCompanyId,
    );

    // No company yet means nothing to resolve roles against. Return a
    // principal that can read /auth/me and nothing else, so the frontend can
    // render the "waiting for assignment" state instead of a broken shell.
    if (!activeCompanyId) {
      return this.pendingPrincipal(user, companies);
    }

    // Keycloak is login only: roles come from grants made in this app, never from token roles.
    const userRoles = await this.roles.rolesForUser(user.id, activeCompanyId);
    const permissions = RolesService.permissionsOf(userRoles);

    /*
      The levels the caller's roles carry, as they stand right now. Read off
      the roles rather than stored on the user: a role's level is edited in one
      place and takes effect on everybody holding it at their next request.
    */
    const visibilityLevels = userRoles
      .map((userRole) => userRole.role.visibilityLevel)
      .filter((level): level is NonNullable<typeof level> => level !== null);

    const [
      sensitiveFieldsVisible,
      sensitiveFieldsAll,
      ledUnitIds,
      levelUnitIds,
      scoped,
    ] = await Promise.all([
      this.policy.resolveVisibleSensitiveFields(permissions),
      this.policy.listAllSensitiveFieldKeys(),
      this.org.ledUnitIdsOf(user.id, activeCompanyId),
      this.org.levelUnitIdsOf(
        user.orgUnitId,
        activeCompanyId,
        visibilityLevels,
      ),
      /*
        Resolved alongside the groups they lead, not after: this runs while
        building the principal for *every* request, and a serial round trip
        here is what once made core-service's five-second resolve timeout
        fire on a cold call.
      */
      this.org.scopedAccessOf(user.id, activeCompanyId),
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
      ledUnitIds,
      levelUnitIds,
      scopedUnitIds: scoped.readUnits,
      scopedActUnitIds: scoped.actUnits,
      scopedUserIds: scoped.readUsers,
      scopedActUserIds: scoped.actUsers,
      scopedByPermission: scoped.byPermission,
      roles: userRoles.map((userRole) => userRole.role.code),
      permissions,
      sensitiveFieldsVisible,
      sensitiveFieldsAll,
      /*
        Always a person here. A machine credential returns from `resolve`
        before provisioning — it has no `User` row, by design, or an admin
        would be invited to assign a team to a robot.
      */
      isServiceAccount: false,
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

  private pendingPrincipal(
    user: User,
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
      ledUnitIds: [],
      levelUnitIds: [],
      scopedUnitIds: [],
      scopedActUnitIds: [],
      scopedUserIds: [],
      scopedActUserIds: [],
      scopedByPermission: {},
      roles: [],
      permissions: [] as Permission[],
      sensitiveFieldsVisible: [],
      sensitiveFieldsAll: [],
      // A `User` row is always a person — see `principalFor`.
      isServiceAccount: false,
      pendingOrgAssignment: true,
    };
  }

  /**
   * A principal for a machine credential — no local profile, no company.
   * Permissions are the forwarded API key `scopes`, and only on the integration
   * client's own token: token roles grant nothing, and the realm is shared.
   */
  private serviceAccountPrincipal(
    payload: KeycloakJwtPayload,
    keyScopes: readonly string[],
  ): Principal {
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
      ledUnitIds: [],
      levelUnitIds: [],
      scopedUnitIds: [],
      scopedActUnitIds: [],
      scopedUserIds: [],
      scopedActUserIds: [],
      scopedByPermission: {},
      roles: [],
      permissions: this.isIntegrationClient(username)
        ? keyScopes.filter(isPermission)
        : [],
      sensitiveFieldsVisible: [],
      sensitiveFieldsAll: [],
      isServiceAccount: true,
      pendingOrgAssignment: false,
    };
  }

  private isIntegrationClient(username: string): boolean {
    const clientId = this.config.get<string>('keycloak.integrationClientId');
    return !!clientId && username === `service-account-${clientId}`;
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
