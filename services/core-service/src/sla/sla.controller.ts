import { Body, Controller, Get, Param, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Permissions } from '@request-management/share';
import { notImplemented } from '../common/not-implemented';

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
  @Get('sla-configs')
  @Permissions('admin.sla.manage')
  listConfigs(@Query('company_id') _companyId?: string) {
    return notImplemented('SUP-01');
  }

  @Put('sla-configs')
  @Permissions('admin.sla.manage')
  replaceConfigs(@Body() _body: unknown) {
    return notImplemented('SUP-01');
  }

  @Get('holiday-calendars')
  @Permissions('admin.sla.manage')
  listCalendars() {
    return notImplemented('SUP-01');
  }

  @Put('holiday-calendars/:companyId')
  @Permissions('admin.sla.manage')
  replaceCalendar(
    @Param('companyId') _companyId: string,
    @Body() _body: unknown,
  ) {
    return notImplemented('SUP-01');
  }
}
