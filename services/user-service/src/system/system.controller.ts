import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  AnySystemPermission,
  CurrentPrincipal,
  SystemPermissions,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import {
  CreateCompanyDto,
  CreateSharedRoleDto,
  GrantCompanyRoleDto,
  GrantSystemRoleDto,
  ReplaceUserCompaniesDto,
  SearchSystemUsersDto,
  SuspendUserDto,
  UpdateCompanyDto,
  UpdateSharedRoleDto,
} from './dto/system.dto';
import { AuditService } from '../audit/audit.service';
import { QuerySystemAuditLogDto } from '../audit/dto/query-audit-log.dto';
import { SystemService } from './system.service';

/** P5 — the only routes that cross companies; every one is gated on `system.*`. */
@ApiTags('system')
@ApiBearerAuth()
@Controller('system')
export class SystemController {
  constructor(
    private readonly system: SystemService,
    private readonly audit: AuditService,
  ) {}

  /** P8 — every company, one with `company_id`, or `company_id=system` for rows no company owns. */
  @Get('audit')
  @SystemPermissions('system.audit.read')
  searchAudit(@Query() query: QuerySystemAuditLogDto) {
    const companyId =
      query.company_id === 'system' ? null : query.company_id || undefined;
    return this.audit.search(query, companyId);
  }

  @Get('users')
  @SystemPermissions('system.user.read')
  searchUsers(@Query() query: SearchSystemUsersDto) {
    return this.system.searchUsers(query);
  }

  @Post('users/:id/suspend')
  @HttpCode(200)
  @SystemPermissions('system.user.manage')
  suspend(
    @Param('id') id: string,
    @Body() dto: SuspendUserDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.system.suspend(id, dto, principal);
  }

  @Post('users/:id/reactivate')
  @HttpCode(200)
  @SystemPermissions('system.user.manage')
  reactivate(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.system.reactivate(id, principal);
  }

  @Put('users/:id/companies')
  @SystemPermissions('system.user.manage')
  replaceCompanies(
    @Param('id') id: string,
    @Body() dto: ReplaceUserCompaniesDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.system.replaceCompanies(id, dto, principal);
  }

  @Post('users/:id/company-roles')
  @HttpCode(204)
  @SystemPermissions('system.user.manage')
  grantCompanyRole(
    @Param('id') id: string,
    @Body() dto: GrantCompanyRoleDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.system.grantCompanyRole(
      id,
      dto.company_id,
      dto.role_id,
      principal,
    );
  }

  @Delete('users/:id/company-roles/:companyId/:roleId')
  @HttpCode(204)
  @SystemPermissions('system.user.manage')
  revokeCompanyRole(
    @Param('id') id: string,
    @Param('companyId') companyId: string,
    @Param('roleId') roleId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.system.revokeCompanyRole(id, companyId, roleId, principal);
  }

  @Post('users/:id/system-roles')
  @HttpCode(204)
  @SystemPermissions('system.role.manage')
  grantSystemRole(
    @Param('id') id: string,
    @Body() dto: GrantSystemRoleDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.system.grantSystemRole(id, dto.role_id, principal);
  }

  @Delete('users/:id/system-roles/:roleId')
  @HttpCode(204)
  @SystemPermissions('system.role.manage')
  revokeSystemRole(
    @Param('id') id: string,
    @Param('roleId') roleId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.system.revokeSystemRole(id, roleId, principal);
  }

  /** Read by the users screen's filter and by the company switcher (P6). */
  @Get('companies')
  @AnySystemPermission(
    'system.user.read',
    'system.tenant.read',
    'system.company.manage',
  )
  listCompanies() {
    return this.system.listCompanies();
  }

  /** ภาพรวมของบริษัทเดียว + ผู้ดูแล — ไม่มีข้อมูลงาน (คำขอ ลูกค้า) */
  @Get('companies/:id')
  @SystemPermissions('system.company.manage')
  getCompany(@Param('id') id: string) {
    return this.system.getCompany(id);
  }

  @Post('companies')
  @SystemPermissions('system.company.manage')
  createCompany(
    @Body() dto: CreateCompanyDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.system.createCompany(dto, principal);
  }

  @Patch('companies/:id')
  @SystemPermissions('system.company.manage')
  updateCompany(
    @Param('id') id: string,
    @Body() dto: UpdateCompanyDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.system.updateCompany(id, dto, principal);
  }

  /** The catalog for the shared-role editor; `/admin/permissions` needs a company right. */
  @Get('permissions')
  @SystemPermissions('system.role.manage')
  listPermissions() {
    return this.system.listPermissions();
  }

  @Get('roles')
  @SystemPermissions('system.role.manage')
  listRoles() {
    return this.system.listSharedRoles();
  }

  @Post('roles')
  @SystemPermissions('system.role.manage')
  createRole(
    @Body() dto: CreateSharedRoleDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.system.createSharedRole(dto, principal);
  }

  @Patch('roles/:id')
  @SystemPermissions('system.role.manage')
  updateRole(
    @Param('id') id: string,
    @Body() dto: UpdateSharedRoleDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.system.updateSharedRole(id, dto, principal);
  }

  @Get('roles/:id/users')
  @SystemPermissions('system.role.manage')
  roleHolders(@Param('id') id: string) {
    return this.system.systemRoleHolders(id);
  }
}
