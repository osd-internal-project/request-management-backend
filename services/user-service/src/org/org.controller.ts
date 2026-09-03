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
  AnyPermission,
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
  ReplaceOrgUnitScopesDto,
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

  /**
   * Which groups this group may see the work of — A4's "ขอบเขตข้อมูล" pane.
   *
   * The replacement for `GET/PUT /admin/scope-rules`, which stored a level per
   * role and could never express "ฝ่ายขาย sees ฝ่ายการตลาด". Those endpoints
   * still exist and are still read by nothing.
   */
  @Get('org-units/:id/scopes')
  @Permissions('admin.org.manage')
  listScopes(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
    @Query('company_id') companyId?: string,
  ) {
    return this.orgService.listScopes(
      id,
      resolveTargetCompany(principal, companyId),
    );
  }

  @Put('org-units/:id/scopes')
  @Permissions('admin.org.manage')
  replaceScopes(
    @Param('id') id: string,
    @Body() dto: ReplaceOrgUnitScopesDto,
    @CurrentPrincipal() principal: Principal,
    @Query('company_id') companyId?: string,
  ) {
    return this.orgService.replaceScopes(
      id,
      dto,
      resolveTargetCompany(principal, companyId),
      principal,
    );
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
 * The org chart for everybody else — the shape, and nothing more.
 *
 * The submit screen needs it to offer a receiving team as a tree and then to
 * narrow the receiver list to that team **and everything under it**: after the
 * chart gained a fourth level, people sit at positions beneath a department,
 * so matching a department exactly found nobody. 36 of the 40 types with a
 * receiving team were offering an empty receiver list on 1 ก.ย. 2569.
 *
 * It could not use `GET /admin/org-units`, which needs `admin.org.manage` — a
 * page that fetches what its viewer cannot read is a guaranteed 403. So this
 * exists, gated on `user.read`: the same permission behind `GET /users`, which
 * the very same screen already uses to list people. The outline of the
 * organisation discloses nothing the directory does not.
 *
 * Separate controller because {@link OrgController} is mounted at `admin` and
 * every route under it is administration. This one is not.
 */
@ApiTags('org')
@ApiBearerAuth()
@Controller()
export class OrgChartController {
  constructor(private readonly orgService: OrgService) {}

  /**
   * Units of the caller's company: id, code, name, kind, parent, active.
   *
   * `request.create` is accepted alongside `user.read` for the same reason
   * `GET /users` accepts it: this is what the submit screen needs to offer a
   * receiving team, and a plain `employee` holds neither today.
   */
  @Get('org-units')
  @AnyPermission('user.read', 'request.create')
  listUnitShapes(
    @CurrentPrincipal() principal: Principal,
    @Query('company_id') companyId?: string,
  ) {
    // SCOPE-03 — asking for a company you do not belong to is refused here,
    // not answered with an empty list.
    return this.orgService.listUnitShapes(
      resolveTargetCompany(principal, companyId),
    );
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
