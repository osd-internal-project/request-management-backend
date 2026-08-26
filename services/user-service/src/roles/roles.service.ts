import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  ALL_PERMISSIONS,
  AppError,
  assertCompanyMember,
  Permission,
  permissionModule,
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
import { RoleRepository, RoleWithPermissions } from './role.repository';
import { UserRoleRepository, UserRoleWithRole } from './user-role.repository';
import {
  CreateRoleDto,
  ReplaceKeycloakMappingsDto,
  UpdateRoleDto,
} from './dto/role.dto';

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

  listRoles(companyId: string): Promise<RoleWithPermissions[]> {
    return this.roles.findForCompany(companyId);
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

  async createRole(
    dto: CreateRoleDto,
    actor: Principal,
  ): Promise<RoleWithPermissions> {
    // An absent company means a role every company shares, so this validates
    // only what was named — without it an admin could define a role inside a
    // company they have no membership in.
    if (dto.company_id) assertCompanyMember(actor, dto.company_id);

    return this.transactions.execute(async (prisma) => {
      const option = { prisma };

      const role = await this.roles.createRole(
        {
          companyId: dto.company_id ?? null,
          code: dto.code,
          name: dto.name,
          description: dto.description,
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
          after: { code: role.code, permissions: dto.permissions },
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
            permissions: before.permissions.map((p) => p.permissionCode),
          },
          after: {
            name: after.name,
            active: after.active,
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
