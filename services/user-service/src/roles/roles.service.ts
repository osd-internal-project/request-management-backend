import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  ALL_PERMISSIONS,
  AppError,
  assertCompanyMember,
  assertSeparationOfDuties,
  Permission,
  permissionModule,
  permissionType,
  Principal,
  PrismaTransactionService,
  TxOption,
} from '@request-management/share';
import type {
  KeycloakRoleMapping,
  Permission as PermissionRow,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuditEvent } from '../audit/audit-events';
import { KeycloakRoleMappingRepository } from './keycloak-role-mapping.repository';
import { PermissionRepository } from './permission.repository';
import {
  RoleRepository,
  RoleWithHolderCount,
  RoleWithPermissions,
} from './role.repository';
import {
  RoleHolder,
  UserRoleRepository,
  UserRoleWithRole,
} from './user-role.repository';
import {
  CreateRoleDto,
  ReplaceKeycloakMappingsDto,
  UpdateRoleDto,
} from './dto/role.dto';

/** What one run of {@link RolesService.syncNamesFromKeycloak} changed. */
export interface KeycloakNameSyncReport {
  /** Rows that had no `keycloakRoleId` and now carry one. */
  readonly linked: string[];
  /** Realm roles that had been renamed; the mapping now follows. */
  readonly renamed: { from: string; to: string }[];
  /**
   * Mappings whose realm role is not in the realm any more.
   *
   * Reported rather than removed — see the method's own comment for why.
   */
  readonly missing: string[];
  readonly checked: number;
}

@Injectable()
export class RolesService implements OnModuleInit {
  private readonly logger = new Logger(RolesService.name);

  constructor(
    private readonly roles: RoleRepository,
    private readonly userRoles: UserRoleRepository,
    private readonly permissions: PermissionRepository,
    private readonly mappings: KeycloakRoleMappingRepository,
    private readonly audit: AuditService,
    private readonly transactions: PrismaTransactionService,
  ) {}

  /** Keeps the `permissions` table in step with the code catalog. */
  async onModuleInit(): Promise<void> {
    try {
      const inserted = await this.permissions.syncCatalog(
        ALL_PERMISSIONS.map((code) => ({
          code,
          module: permissionModule(code),
          type: permissionType(code),
        })),
      );

      if (inserted) {
        this.logger.log(
          `Synced ${inserted} new permission(s) into the catalog`,
        );
      }
    } catch (error) {
      // A database that is not up yet must not stop the service booting —
      // the catalog re-syncs on the next start.
      this.logger.warn(
        `Could not sync the permission catalog: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }

  listPermissions(): Promise<PermissionRow[]> {
    return this.permissions.findAll();
  }

  listRoles(companyId: string): Promise<RoleWithHolderCount[]> {
    return this.roles.findForCompany(companyId);
  }

  /**
   * Screen A4's right-hand panel: who holds this role in this company.
   *
   * The role is looked up first so an id from another company answers
   * `NOT_FOUND` rather than an empty list, which would read as "nobody holds
   * it" when the truth is "you are looking at the wrong company".
   */
  async holdersOf(
    roleId: string,
    companyId: string,
  ): Promise<readonly RoleHolder[]> {
    const role = await this.roles.findById(roleId);

    if (!role || (role.companyId !== null && role.companyId !== companyId)) {
      throw new AppError('NOT_FOUND', 'ไม่พบบทบาทที่ระบุ');
    }

    return this.userRoles.holdersOfRoleId(roleId, companyId);
  }

  /** Who holds a role code in this company — used to resolve approval chains. */
  holdersOfRole(
    companyId: string,
    roleCode: string,
    option?: TxOption,
  ): Promise<string[]> {
    return this.userRoles.holdersOfRole(companyId, roleCode, option);
  }

  rolesForUser(
    userId: string,
    companyId: string,
    option?: TxOption,
  ): Promise<UserRoleWithRole[]> {
    return this.userRoles.findForUserInCompany(userId, companyId, option);
  }

  /** The same, for a list of people at once — see the repository's note. */
  rolesForUsers(
    userIds: readonly string[],
    companyId: string,
    option?: TxOption,
  ): Promise<Map<string, UserRoleWithRole[]>> {
    return this.userRoles.findForUsersInCompany(userIds, companyId, option);
  }

  async createRole(
    dto: CreateRoleDto,
    actor: Principal,
  ): Promise<RoleWithPermissions> {
    // An absent company means a role every company shares, so this validates
    // only what was named — without it an admin could define a role inside a
    // company they have no membership in.
    if (dto.company_id) assertCompanyMember(actor, dto.company_id);

    assertSeparationOfDuties(dto.permissions);

    return this.transactions.execute(async (prisma) => {
      const option = { prisma };

      const role = await this.roles.createRole(
        {
          companyId: dto.company_id ?? null,
          code: dto.code,
          name: dto.name,
          description: dto.description,
          visibilityLevel: dto.visibility_level ?? null,
          createdBy: actor.userId,
          updatedBy: actor.userId,
        },
        dto.permissions,
        option,
      );

      await this.audit.record(
        {
          eventType: AuditEvent.ROLE_CREATED,
          companyId: dto.company_id ?? actor.activeCompanyId,
          actorId: actor.userId,
          actorUsername: actor.username,
          resourceType: 'role',
          resourceId: role.id,
          after: {
            code: role.code,
            permissions: dto.permissions,
            visibilityLevel: role.visibilityLevel,
          },
        },
        option,
      );

      return role;
    });
  }

  async updateRole(
    id: string,
    dto: UpdateRoleDto,
    actor: Principal,
  ): Promise<RoleWithPermissions> {
    return this.transactions.execute(async (prisma) => {
      const option = { prisma };

      const before = await this.roles.findById(id, option);
      if (!before) {
        throw new AppError('NOT_FOUND', 'ไม่พบบทบาทที่ระบุ');
      }

      // §5.4 guardrail 1. `updateRole` replaces the permission set wholesale,
      // so `dto.permissions` is exactly what the role ends up holding.
      //
      // Checked only when permissions are supplied: a role seeded before this
      // rule existed must still be renameable and — more importantly —
      // deactivatable, which is the remedy for it. Blocking every PATCH on a
      // legacy violation would leave it in place with no way to retire it.
      if (dto.permissions) assertSeparationOfDuties(dto.permissions);

      // ROLE-02: a role with holders can be switched off but never removed,
      // so historical grants stay explainable.
      if (dto.active === false) {
        const holders = await this.roles.countUsers(id, option);
        this.logger.log(
          `Deactivating role ${before.code} with ${holders} holder(s)`,
        );
      }

      const after = await this.roles.updateRole(
        id,
        {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.description !== undefined
            ? { description: dto.description }
            : {}),
          ...(dto.active !== undefined ? { active: dto.active } : {}),
          /*
            Present-and-null clears the level; absent leaves it alone. Spread
            conditionally rather than `?? before.visibilityLevel`, which would
            make "clear it" unexpressible.
          */
          ...('visibility_level' in dto
            ? { visibilityLevel: dto.visibility_level ?? null }
            : {}),
          updatedBy: actor.userId,
        },
        dto.permissions,
        option,
      );

      await this.audit.record(
        {
          eventType:
            dto.active === false
              ? AuditEvent.ROLE_DEACTIVATED
              : AuditEvent.ROLE_UPDATED,
          companyId: before.companyId ?? actor.activeCompanyId,
          actorId: actor.userId,
          actorUsername: actor.username,
          resourceType: 'role',
          resourceId: id,
          before: {
            name: before.name,
            active: before.active,
            visibilityLevel: before.visibilityLevel,
            permissions: before.permissions.map((p) => p.permissionCode),
          },
          after: {
            name: after.name,
            active: after.active,
            visibilityLevel: after.visibilityLevel,
            permissions: after.permissions.map((p) => p.permissionCode),
          },
        },
        option,
      );

      return after;
    });
  }

  /**
   * ROLE-02 explicitly forbids deleting a role that has holders. Deletion is
   * not implemented at all — there is no endpoint and no service method, so
   * the rule cannot be bypassed by a future caller.
   */
  async grantRole(
    userId: string,
    roleId: string,
    companyId: string,
    actor: Principal,
  ): Promise<void> {
    await this.transactions.execute(async (prisma) => {
      const option = { prisma };

      const role = await this.roles.findById(roleId, option);
      if (!role || !role.active) {
        throw new AppError('NOT_FOUND', 'ไม่พบบทบาทที่ใช้งานอยู่');
      }

      await this.userRoles.grant(
        { userId, roleId, companyId, grantedByUserId: actor.userId },
        option,
      );

      await this.audit.record(
        {
          eventType: AuditEvent.ROLE_GRANTED,
          companyId,
          actorId: actor.userId,
          actorUsername: actor.username,
          resourceType: 'user',
          resourceId: userId,
          after: { roleId, roleCode: role.code, companyId },
        },
        option,
      );
    });
  }

  async revokeRole(
    userId: string,
    roleId: string,
    companyId: string,
    actor: Principal,
  ): Promise<void> {
    await this.transactions.execute(async (prisma) => {
      const option = { prisma };

      await this.userRoles.revoke(userId, roleId, companyId, option);

      await this.audit.record(
        {
          eventType: AuditEvent.ROLE_REVOKED,
          companyId,
          actorId: actor.userId,
          actorUsername: actor.username,
          resourceType: 'user',
          resourceId: userId,
          before: { roleId, companyId },
        },
        option,
      );
    });
  }

  listMappings(companyId: string): Promise<KeycloakRoleMapping[]> {
    return this.mappings.findForCompany(companyId);
  }

  async replaceMappings(
    dto: ReplaceKeycloakMappingsDto,
    actor: Principal,
  ): Promise<KeycloakRoleMapping[]> {
    assertCompanyMember(actor, dto.company_id);

    return this.transactions.execute(async (prisma) => {
      const option = { prisma };

      const before = await this.mappings.findForCompany(dto.company_id, option);
      const after = await this.mappings.replaceForCompany(
        dto.company_id,
        dto.mappings.map((entry) => ({
          keycloakRole: entry.keycloak_role,
          roleId: entry.role_id,
        })),
        actor.userId,
        option,
      );

      await this.audit.record(
        {
          eventType: AuditEvent.KEYCLOAK_MAPPING_UPDATED,
          companyId: dto.company_id,
          actorId: actor.userId,
          actorUsername: actor.username,
          resourceType: 'keycloak_role_mapping',
          resourceId: dto.company_id,
          before: before.map((row) => ({
            keycloakRole: row.keycloakRole,
            roleId: row.roleId,
          })),
          after: after.map((row) => ({
            keycloakRole: row.keycloakRole,
            roleId: row.roleId,
          })),
        },
        option,
      );

      return after;
    });
  }

  /**
   * Brings the mapping table back in line with the realm — names only.
   *
   * **One way, Keycloak → here.** Nothing in this method writes to Keycloak,
   * which is what keeps `admin.role.manage` from becoming a route to
   * administering the realm. The names are the realm's to decide; the
   * permissions behind each role stay this system's.
   *
   * The failure it exists to prevent: `keycloakRole` holds a *name*, and a name
   * is the one thing about a realm role that changes. When somebody renamed one
   * the next token carried the new name, no mapping matched it, and
   * `syncFromKeycloakRoles` removed that role from every holder — silently, and
   * with this table still displaying the old name as though nothing had
   * happened. `keycloakRoleId` survives a rename, so it is what lets the name be
   * corrected instead.
   *
   * Takes the realm roles as an argument rather than fetching them: the rule is
   * then testable without Keycloak, and the transport stays in the one class
   * that owns it (`KeycloakAdminService`).
   *
   * A mapping whose realm role has **disappeared** is reported, never deleted.
   * A role missing from a list could equally mean the realm is half-configured
   * or the admin API answered oddly, and quietly dropping mappings on that
   * evidence is how everyone loses their permissions at once — the very thing
   * this method was written to stop.
   */
  async syncNamesFromKeycloak(
    companyId: string,
    realmRoles: readonly { id: string; name: string; description?: string }[],
    actorId: string,
  ): Promise<KeycloakNameSyncReport> {
    const byId = new Map(realmRoles.map((role) => [role.id, role]));
    const byName = new Map(realmRoles.map((role) => [role.name, role]));

    const mappings = await this.mappings.findForCompany(companyId);

    const linked: string[] = [];
    const renamed: KeycloakNameSyncReport['renamed'] = [];
    const missing: string[] = [];

    for (const mapping of mappings) {
      // First run: the row predates `keycloakRoleId`. Match it by the name it
      // still holds, which is correct precisely while nothing has been renamed.
      if (!mapping.keycloakRoleId) {
        const found = byName.get(mapping.keycloakRole);

        if (!found) {
          missing.push(mapping.keycloakRole);
          continue;
        }

        await this.mappings.update({
          where: { id: mapping.id },
          data: { keycloakRoleId: found.id },
        });
        linked.push(mapping.keycloakRole);
        continue;
      }

      const realm = byId.get(mapping.keycloakRoleId);

      if (!realm) {
        missing.push(mapping.keycloakRole);
        continue;
      }

      if (realm.name === mapping.keycloakRole) continue;

      await this.mappings.update({
        where: { id: mapping.id },
        data: { keycloakRole: realm.name },
      });

      renamed.push({ from: mapping.keycloakRole, to: realm.name });

      /*
        The realm's `description` is the only human label a realm role carries,
        so it is what a display name can follow. `Role.code` is untouched in
        every branch: `assertSeparationOfDuties`, the seed and the `cfo`/`ceo`
        lookups all key off it, and letting a realm administrator change it
        would hand them a way around §5.4 from outside this system.
      */
      if (realm.description) {
        await this.roles.update({
          where: { id: mapping.roleId },
          data: { name: realm.description },
        });
      }

      await this.audit.record({
        eventType: AuditEvent.KEYCLOAK_ROLE_RENAMED,
        companyId,
        actorId,
        resourceType: 'keycloak_role_mapping',
        resourceId: mapping.id,
        before: { keycloakRole: mapping.keycloakRole },
        after: { keycloakRole: realm.name, roleId: mapping.roleId },
      });
    }

    return { linked, renamed, missing, checked: mappings.length };
  }

  /**
   * ROLE-03: re-derives the user's mapped roles from the Keycloak claims on
   * every login and refresh.
   *
   * This is what makes revocation work: take a role away in Keycloak and it
   * disappears here within one access-token lifetime, without an admin
   * touching this system.
   */
  async syncFromKeycloakRoles(
    userId: string,
    companyId: string,
    keycloakRoles: readonly string[],
    option?: TxOption,
  ): Promise<void> {
    const matches = await this.mappings.findMatching(
      keycloakRoles,
      companyId,
      option,
    );

    const roleIds = [...new Set(matches.map((match) => match.roleId))];
    const { added, removed } = await this.userRoles.replaceMappedRoles(
      userId,
      companyId,
      roleIds,
      option,
    );

    if (added.length || removed.length) {
      await this.audit.record(
        {
          eventType: AuditEvent.KEYCLOAK_ROLES_SYNCED,
          companyId,
          actorId: userId,
          resourceType: 'user',
          resourceId: userId,
          before: { removed },
          after: { added, keycloakRoles: [...keycloakRoles] },
        },
        option,
      );
    }
  }

  /** Flattens a user's roles in one company into a permission set. */
  static permissionsOf(userRoles: readonly UserRoleWithRole[]): Permission[] {
    const codes = new Set<string>();

    for (const userRole of userRoles) {
      for (const permission of userRole.role.permissions) {
        codes.add(permission.permissionCode);
      }
    }

    return [...codes] as Permission[];
  }
}
