import { Body, Controller, Get, Param, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal, Permissions } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { SlaConfigService } from './sla-config.service';
import { ReplaceHolidayCalendarDto, ReplaceSlaConfigsDto } from './dto/sla.dto';

/**
 * §11.6 group E (SLA half) — the minimum clock, delivered in **S3**.
 *
 * §09 is explicit that this is a stand-in for the full central SLA engine:
 * one calendar per company, no shifts. The interface is shaped so the full
 * engine can replace it without Request or Approval changing.
 */
@ApiTags('admin/sla')
@ApiBearerAuth()
@Controller('admin')
export class SlaController {
  constructor(private readonly configs: SlaConfigService) {}

  @Get('sla-configs')
  @Permissions('admin.sla.manage')
  listConfigs(
    @CurrentPrincipal() principal: Principal,
    @Query('company_id') companyId?: string,
  ) {
    return this.configs.listConfigs(principal, companyId);
  }

  @Put('sla-configs')
  @Permissions('admin.sla.manage')
  replaceConfigs(
    @Body() dto: ReplaceSlaConfigsDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.configs.replaceConfigs(dto, principal);
  }

  @Get('holiday-calendars')
  @Permissions('admin.sla.manage')
  listCalendars(@CurrentPrincipal() principal: Principal) {
    return this.configs.listCalendars(principal);
  }

  @Put('holiday-calendars/:companyId')
  @Permissions('admin.sla.manage')
  replaceCalendar(
    @Param('companyId') companyId: string,
    @Body() dto: ReplaceHolidayCalendarDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.configs.replaceCalendar(companyId, dto, principal);
  }
}
