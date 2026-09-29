import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Permissions, CurrentPrincipal } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { BiService } from './bi.service';
import { DataMartService } from './data-mart.service';
import { CreateBiDashboardDto, UpdateBiDashboardDto } from './dto/bi.dto';

/**
 * CD-92: the BI menu, composed per caller like every other menu (ROLE-06).
 *
 * `report.dashboard.read` gates the endpoint; which dashboards appear is then
 * decided by the `bi_dashboards` configuration — each row optionally scoped
 * to org units, so different teams see different menus. Embed URLs are
 * short-lived signed tokens — sharing one around dies within minutes, and
 * nothing here ever proxies Metabase credentials.
 */
@ApiTags('bi')
@Controller('bi')
export class BiController {
  constructor(private readonly bi: BiService) {}

  @Get('menu')
  @Permissions('report.dashboard.read')
  menu(@CurrentPrincipal() principal: Principal) {
    return this.bi.menu(principal);
  }
}

/**
 * CD-92 v2 — dashboard configuration, editable without a deploy.
 *
 * `GET org-units` exists so the audience picker does not require
 * `admin.org.manage`: a BI admin needs unit names to scope a dashboard, not
 * the power to edit the org chart.
 */
@ApiTags('admin/bi')
@ApiBearerAuth()
@Controller('admin/bi')
export class BiAdminController {
  constructor(
    private readonly bi: BiService,
    private readonly mart: DataMartService,
  ) {}

  /** CD-91 — when each Data Mart table was last rebuilt. */
  @Get('mart')
  @Permissions('admin.bi.manage')
  martStatus() {
    return this.mart.status();
  }

  /** CD-91 — rebuild the Data Mart now instead of waiting for the hour. */
  @Post('mart/refresh')
  @Permissions('admin.bi.manage')
  @HttpCode(200)
  refreshMart(@CurrentPrincipal() principal: Principal) {
    return this.mart.refreshNow(principal);
  }

  @Get('dashboards')
  @Permissions('admin.bi.manage')
  list(
    @CurrentPrincipal() principal: Principal,
    @Query('company_id') companyId?: string,
  ) {
    return this.bi.listAdmin(principal, companyId);
  }

  @Post('dashboards')
  @Permissions('admin.bi.manage')
  create(
    @Body() dto: CreateBiDashboardDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.bi.create(dto, principal);
  }

  @Put('dashboards/:id')
  @Permissions('admin.bi.manage')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateBiDashboardDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.bi.update(id, dto, principal);
  }

  @Delete('dashboards/:id')
  @HttpCode(204)
  @Permissions('admin.bi.manage')
  async remove(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.bi.deactivate(id, principal);
  }

  @Get('org-units')
  @Permissions('admin.bi.manage')
  listOrgUnits(
    @CurrentPrincipal() principal: Principal,
    @Query('company_id') companyId?: string,
  ) {
    return this.bi.listOrgUnits(principal, companyId);
  }
}
