import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  Authenticated,
  CurrentPrincipal,
  Permissions,
  resolveTargetCompany,
  ServiceAccountAllowed,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import { OrgService } from './org.service';
import { ApprovalContextService } from './approval-context.service';
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
      resolveTargetCompany(principal, companyId),
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
      resolveTargetCompany(principal, companyId),
    );
  }

  /**
   * Everyone under a group, its sub-groups included.
   *
   * Screen A1 needs it: choosing a group as an approval level then offers the
   * people in it, and "in it" has to mean the subtree — naming a department
   * and being offered nobody because the people sit in positions under it
   * would make the picker useless.
   */
  @Get('org-units/:id/members/recursive')
  @Permissions('admin.org.manage')
  listMembersRecursive(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
    @Query('company_id') companyId?: string,
  ) {
    return this.orgService.listMembersRecursive(
      id,
      resolveTargetCompany(principal, companyId),
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

  /**
   * Removes a group entirely. Refused with `ORG_UNIT_IN_USE` while anything
   * still points at it — see `OrgService.deleteUnit`.
   */
  @Delete('org-units/:id')
  @Permissions('admin.org.manage')
  @HttpCode(204)
  async deleteUnit(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<void> {
    await this.orgService.deleteUnit(id, principal);
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

/**
 * The identity facts core-service needs to build an approval chain.
 *
 * Internal, and `@Authenticated()` rather than permission-gated for the same
 * reason as `/internal/policy/resolve`: it discloses nothing the caller could
 * not already infer, and gating it on a business permission would mean the
 * approval engine needed one.
 */
@ApiTags('internal')
@ApiBearerAuth()
@Controller('internal/org')
export class OrgInternalController {
  constructor(private readonly approvalContext: ApprovalContextService) {}

  @Get('approval-context')
  @Authenticated()
  @ServiceAccountAllowed()
  resolve(
    @CurrentPrincipal() principal: Principal,
    @Query('user_id') userId?: string,
    @Query('company_id') companyId?: string,
  ) {
    return this.approvalContext.resolve(
      userId ?? principal.userId,
      resolveTargetCompany(principal, companyId),
    );
  }
}
