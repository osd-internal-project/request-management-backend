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
  Permissions,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import {
  ListNotificationsQueryDto,
  NotificationLogQueryDto,
  UpdateNotificationPreferencesDto,
} from './dto/notification.dto';
import { NotificationLogService } from './notification-log.service';
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
  constructor(
    private readonly notifications: NotificationsService,
    private readonly log: NotificationLogService,
  ) {}

  @Get()
  @Permissions('notification.read')
  list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListNotificationsQueryDto,
  ) {
    return this.notifications.list(principal, query);
  }

  /**
   * CD-55 — บันทึกการแจ้งเตือนของทั้งบริษัท (ใคร เมื่อไร ช่องทาง อ่านแล้วหรือยัง).
   * Read-only, like `/audit-logs`, and behind the same permission.
   */
  @Get('log')
  @Permissions('audit.read')
  searchLog(
    @CurrentPrincipal() principal: Principal,
    @Query() query: NotificationLogQueryDto,
  ) {
    return this.log.search(query, principal);
  }

  /** ตัวเลขบนกระดิ่ง — เบากว่าดึงรายการทั้งหน้าทุกครั้งที่ polling. */
  @Get('unread-count')
  @Permissions('notification.read')
  unreadCount(@CurrentPrincipal() principal: Principal) {
    return this.notifications.unreadCount(principal);
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
    return this.notifications.updatePreferences(principal, dto);
  }
}
