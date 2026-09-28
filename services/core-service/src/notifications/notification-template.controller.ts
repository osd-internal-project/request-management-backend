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
import { SaveNotificationTemplateDto } from './dto/notification.dto';
import { NotificationTemplateAdminService } from './notification-template-admin.service';

/**
 * CD-54 — each company's wording for each notification event. The standard
 * wording is in code; a saved template replaces it for that company only,
 * and DELETE puts the standard back.
 */
@ApiTags('admin/notification-templates')
@ApiBearerAuth()
@Controller('admin/notification-templates')
export class NotificationTemplateController {
  constructor(private readonly templates: NotificationTemplateAdminService) {}

  @Get()
  @Permissions('admin.notification.manage')
  list(
    @CurrentPrincipal() principal: Principal,
    @Query('company_id') companyId?: string,
  ) {
    return this.templates.list(principal, companyId);
  }

  @Put(':eventType')
  @Permissions('admin.notification.manage')
  save(
    @Param('eventType') eventType: string,
    @Body() dto: SaveNotificationTemplateDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.templates.save(eventType, dto, principal);
  }

  @Delete(':eventType')
  @Permissions('admin.notification.manage')
  reset(
    @Param('eventType') eventType: string,
    @CurrentPrincipal() principal: Principal,
    @Query('company_id') companyId?: string,
  ) {
    return this.templates.reset(eventType, principal, companyId);
  }
}
