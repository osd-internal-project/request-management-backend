import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Put,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AppError, CurrentPrincipal, Permissions } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { AuditService } from '../audit/audit.service';
import { AuditEvent } from '../audit/audit-events';
import { KeycloakAdminService } from './keycloak-admin.service';

/**
 * Keycloak identity data, surfaced so screen A3 can show and edit a member's
 * realm roles and groups without sending admins to the Keycloak console.
 *
 * Everything here sits behind `admin.identity.manage` — deliberately not
 * `admin.role.manage`, because these calls reach outside our database into the
 * shared corporate realm. Every write is audited (SUP-04).
 */
@ApiTags('admin/keycloak')
@ApiBearerAuth()
@Controller('admin/keycloak')
export class KeycloakAdminController {
  constructor(
    private readonly keycloak: KeycloakAdminService,
    private readonly audit: AuditService,
  ) {}

  @Get('roles')
  @Permissions('admin.identity.manage')
  listRoles() {
    return this.keycloak.listRealmRoles();
  }

  @Get('groups')
  @Permissions('admin.identity.manage')
  listGroups() {
    return this.keycloak.listGroups();
  }

  @Get('users')
  @Permissions('admin.identity.manage')
  searchUsers(@Query('q') q = '') {
    return this.keycloak.searchUsers(q);
  }

  /** Roles and groups for one user, as the A3 member panel shows them. */
  @Get('users/:username/identity')
  @Permissions('admin.identity.manage')
  async identityOf(@Param('username') username: string) {
    const user = await this.require(username);
    const [roles, groups] = await Promise.all([
      this.keycloak.listUserRoles(user.id),
      this.keycloak.listUserGroups(user.id),
    ]);

    return {
      user: { id: user.id, username: user.username, enabled: user.enabled },
      roles: roles.map((role) => role.name),
      groups: groups.map((group) => ({
        id: group.id,
        name: group.name,
        path: group.path,
      })),
    };
  }

  @Post('users/:username/roles/:role')
  @Permissions('admin.identity.manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  async grantRole(
    @Param('username') username: string,
    @Param('role') role: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    const user = await this.require(username);
    await this.keycloak.grantRealmRole(user.id, role);

    await this.audit.record({
      eventType: AuditEvent.IDENTITY_ROLE_GRANTED,
      companyId: principal.activeCompanyId || null,
      actorId: principal.userId,
      actorUsername: principal.username,
      resourceType: 'keycloak_user',
      resourceId: username,
      after: { role },
    });
  }

  @Delete('users/:username/roles/:role')
  @Permissions('admin.identity.manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokeRole(
    @Param('username') username: string,
    @Param('role') role: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    const user = await this.require(username);
    await this.keycloak.revokeRealmRole(user.id, role);

    await this.audit.record({
      eventType: AuditEvent.IDENTITY_ROLE_REVOKED,
      companyId: principal.activeCompanyId || null,
      actorId: principal.userId,
      actorUsername: principal.username,
      resourceType: 'keycloak_user',
      resourceId: username,
      before: { role },
    });
  }

  @Put('users/:username/groups/:groupId')
  @Permissions('admin.identity.manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  async joinGroup(
    @Param('username') username: string,
    @Param('groupId') groupId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    const user = await this.require(username);
    await this.keycloak.joinGroup(user.id, groupId);

    await this.audit.record({
      eventType: AuditEvent.IDENTITY_GROUP_JOINED,
      companyId: principal.activeCompanyId || null,
      actorId: principal.userId,
      actorUsername: principal.username,
      resourceType: 'keycloak_user',
      resourceId: username,
      after: { groupId },
    });
  }

  @Delete('users/:username/groups/:groupId')
  @Permissions('admin.identity.manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  async leaveGroup(
    @Param('username') username: string,
    @Param('groupId') groupId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    const user = await this.require(username);
    await this.keycloak.leaveGroup(user.id, groupId);

    await this.audit.record({
      eventType: AuditEvent.IDENTITY_GROUP_LEFT,
      companyId: principal.activeCompanyId || null,
      actorId: principal.userId,
      actorUsername: principal.username,
      resourceType: 'keycloak_user',
      resourceId: username,
      before: { groupId },
    });
  }

  private async require(username: string) {
    const user = await this.keycloak.findUserByUsername(username);

    if (!user) {
      throw new AppError('NOT_FOUND', 'ไม่พบผู้ใช้ใน Keycloak', [
        { field: 'username', reason: username },
      ]);
    }

    return user;
  }
}
