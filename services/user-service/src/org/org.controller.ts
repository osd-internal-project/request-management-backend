import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal, Permissions } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { OrgService } from './org.service';
import {
  AssignUserOrgDto,
  CreateOrgUnitDto,
  UpdateOrgUnitDto,
} from './dto/org-unit.dto';

/** Admin screen A3 — "ผังทีมและสิทธิ์". */
@ApiTags('admin/org')
@ApiBearerAuth()
@Controller('admin')
export class OrgController {
  constructor(private readonly orgService: OrgService) {}

  /** The A3 tree — each node carries its manager's name and member count. */
  @Get('org-units')
  @Permissions('admin.org.manage')
  listUnits(
    @CurrentPrincipal() principal: Principal,
    @Query('company_id') companyId?: string,
  ) {
    return this.orgService.listUnitsWithDetail(
      companyId ?? principal.activeCompanyId,
    );
  }

  /** The A3 member panel: role, data scope, and supervisor per person. */
  @Get('org-units/:id/members')
  @Permissions('admin.org.manage')
  listMembers(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
    @Query('company_id') companyId?: string,
  ) {
    return this.orgService.listMembers(
      id,
      companyId ?? principal.activeCompanyId,
    );
  }

  @Post('org-units')
  @Permissions('admin.org.manage')
  createUnit(
    @Body() dto: CreateOrgUnitDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.orgService.createUnit(dto, principal);
  }

  @Patch('org-units/:id')
  @Permissions('admin.org.manage')
  updateUnit(
    @Param('id') id: string,
    @Body() dto: UpdateOrgUnitDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.orgService.updateUnit(id, dto, principal);
  }

  @Get('users/unassigned')
  @Permissions('admin.org.manage')
  listUnassigned() {
    return this.orgService.listUnassignedUsers();
  }

  @Patch('users/:id/org')
  @Permissions('admin.org.manage')
  assignUser(
    @Param('id') id: string,
    @Body() dto: AssignUserOrgDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.orgService.assignUser(id, dto, principal);
  }
}
