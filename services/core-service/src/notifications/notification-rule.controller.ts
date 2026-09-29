import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal, Permissions } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { SaveNotificationRuleDto } from './dto/notification.dto';
import { NotificationRuleAdminService } from './notification-rule-admin.service';

/**
 * CD-53 — each company's reminder rules. The rules are declared in code; a
 * saved setting replaces the standard for that company only, and DELETE
 * puts the standard back.
 */
@ApiTags('admin/notification-rules')
@ApiBearerAuth()
@Controller('admin/notification-rules')
export class NotificationRuleController {
  constructor(private readonly rules: NotificationRuleAdminService) {}

  @Get()
  @Permissions('admin.notification.manage')
  list(
    @CurrentPrincipal() principal: Principal,
    @Query('company_id') companyId?: string,
  ) {
    return this.rules.list(principal, companyId);
  }

  @Put(':code')
  @Permissions('admin.notification.manage')
  save(
    @Param('code') code: string,
    @Body() dto: SaveNotificationRuleDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.rules.save(code, dto, principal);
  }

  @Delete(':code')
  @Permissions('admin.notification.manage')
  reset(
    @Param('code') code: string,
    @CurrentPrincipal() principal: Principal,
    @Query('company_id') companyId?: string,
  ) {
    return this.rules.reset(code, principal, companyId);
  }
}
