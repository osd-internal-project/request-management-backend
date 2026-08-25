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
import { CurrentPrincipal, Permissions } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { RolesService } from './roles.service';
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
  constructor(private readonly rolesService: RolesService) {}

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
    return this.rolesService.listRoles(companyId ?? principal.activeCompanyId);
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
      companyId ?? principal.activeCompanyId,
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
      companyId ?? principal.activeCompanyId,
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
}
