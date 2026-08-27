import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  Authenticated,
  CurrentPrincipal,
  PageQueryDto,
  Permissions,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import { UpdateNotificationPreferencesDto } from './dto/notification.dto';
import { NotificationsService } from './notifications.service';

/**
 * §11.6 group E (notification half) — in-app plus SMTP email, delivered in
 * **S2**. Every send is logged (SUP-03), which is what settles a later
 * "I never got notified".
 */
@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @Permissions('notification.read')
  list(@CurrentPrincipal() principal: Principal, @Query() query: PageQueryDto) {
    return this.notifications.list(principal, query);
  }

  @Post(':id/read')
  @Permissions('notification.read')
  @HttpCode(HttpStatus.NO_CONTENT)
  markRead(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.notifications.markRead(id, principal);
  }

  @Post('read-all')
  @Permissions('notification.read')
  @HttpCode(HttpStatus.NO_CONTENT)
  markAllRead(@CurrentPrincipal() principal: Principal) {
    return this.notifications.markAllRead(principal);
  }

  /** In-app cannot be switched off; only the email channel is optional. */
  @Get('preferences')
  @Authenticated()
  getPreferences(@CurrentPrincipal() principal: Principal) {
    return this.notifications.getPreferences(principal);
  }

  @Put('preferences')
  @Authenticated()
  updatePreferences(
    @Body() dto: UpdateNotificationPreferencesDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.notifications.updatePreferences(principal, dto.email);
  }
}
