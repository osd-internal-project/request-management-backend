import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  CurrentPrincipal,
  Permissions,
  resolveTargetCompany,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import { RolesService } from './roles.service';
import { KeycloakAdminService } from '../keycloak-admin/keycloak-admin.service';
import {
  CreateRoleDto,
  GrantRoleDto,
  ReplaceKeycloakMappingsDto,
  UpdateRoleDto,
} from './dto/role.dto';

/** §11.3 group B — roles and the Keycloak role mapping. */
@ApiTags('admin/roles')
@ApiBearerAuth()
@Controller('admin')
export class RolesController {
  constructor(
    private readonly rolesService: RolesService,
    /*
      Read-only use: `listClientRoles`. The transport stays in the one class
      that owns a Keycloak admin token, and nothing here calls a write.
    */
    private readonly keycloakAdmin: KeycloakAdminService,
  ) {}

  /** Read-only: the catalog is declared in code, not editable here. */
  @Get('permissions')
  @Permissions('admin.role.manage')
  listPermissions() {
    return this.rolesService.listPermissions();
  }

  @Get('roles')
  @Permissions('admin.role.manage')
  listRoles(
    @CurrentPrincipal() principal: Principal,
    @Query('company_id') companyId?: string,
  ) {
    return this.rolesService.listRoles(
      resolveTargetCompany(principal, companyId),
    );
  }

  /**
   * Screen A4 — who holds this role in the active company.
   *
   * Not defined in §11.3: the mockup's "ผู้ใช้ใน role นี้" panel needs names
   * and grant sources, and the spec's endpoint list predates that screen.
   */
  @Get('roles/:id/users')
  @Permissions('admin.role.manage')
  listRoleHolders(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
    @Query('company_id') companyId?: string,
  ) {
    return this.rolesService.holdersOf(
      id,
      resolveTargetCompany(principal, companyId),
    );
  }

  @Post('roles')
  @Permissions('admin.role.manage')
  createRole(
    @Body() dto: CreateRoleDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.rolesService.createRole(dto, principal);
  }

  @Patch('roles/:id')
  @Permissions('admin.role.manage')
  updateRole(
    @Param('id') id: string,
    @Body() dto: UpdateRoleDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.rolesService.updateRole(id, dto, principal);
  }

  @Post('users/:id/roles')
  @Permissions('admin.role.manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  grantRole(
    @Param('id') userId: string,
    @Body() dto: GrantRoleDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.rolesService.grantRole(
      userId,
      dto.role_id,
      dto.company_id,
      principal,
    );
  }

  @Delete('users/:id/roles/:roleId')
  @Permissions('admin.role.manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  revokeRole(
    @Param('id') userId: string,
    @Param('roleId') roleId: string,
    @CurrentPrincipal() principal: Principal,
    @Query('company_id') companyId?: string,
  ) {
    return this.rolesService.revokeRole(
      userId,
      roleId,
      resolveTargetCompany(principal, companyId),
      principal,
    );
  }

  @Get('keycloak-role-mappings')
  @Permissions('admin.role.manage')
  listMappings(
    @CurrentPrincipal() principal: Principal,
    @Query('company_id') companyId?: string,
  ) {
    return this.rolesService.listMappings(
      resolveTargetCompany(principal, companyId),
    );
  }

  @Put('keycloak-role-mappings')
  @Permissions('admin.role.manage')
  replaceMappings(
    @Body() dto: ReplaceKeycloakMappingsDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.rolesService.replaceMappings(dto, principal);
  }

  /**
   * Re-reads the client roles and corrects any mapping whose role has been renamed.
   *
   * One way. This reads the `request-form` client roles and writes only here —
   * `admin.role.manage` administers this system's roles and must never become
   * a way to administer Keycloak (`AGENTS.md`).
   *
   * Manual rather than on every sign-in: it would be one admin-API call per
   * login to catch something that happens a handful of times a year, and a
   * realm that is unreachable would turn into a login nobody can complete.
   */
  @Post('keycloak-role-mappings/sync-names')
  @Permissions('admin.role.manage')
  async syncMappingNames(
    @CurrentPrincipal() principal: Principal,
    @Query('company_id') companyId?: string,
  ) {
    const clientRoles = await this.keycloakAdmin.listClientRoles();

    return this.rolesService.syncNamesFromKeycloak(
      resolveTargetCompany(principal, companyId),
      clientRoles,
      principal.userId,
    );
  }
}
