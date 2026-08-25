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
import { Authenticated, Permissions } from '@request-management/share';
import { notImplemented } from '../common/not-implemented';

/**
 * §11.6 group E (notification half) — in-app plus SMTP email, delivered in
 * **S2**. Every send is logged (SUP-03), which is what settles a later
 * "I never got notified".
 */
@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  @Get()
  @Permissions('notification.read')
  list(@Query('unread') _unread?: string) {
    return notImplemented('SUP-03');
  }

  @Post(':id/read')
  @Permissions('notification.read')
  @HttpCode(HttpStatus.NO_CONTENT)
  markRead(@Param('id') _id: string) {
    return notImplemented('SUP-03');
  }

  @Post('read-all')
  @Permissions('notification.read')
  @HttpCode(HttpStatus.NO_CONTENT)
  markAllRead() {
    return notImplemented('SUP-03');
  }

  /** In-app cannot be switched off; only the email channel is optional. */
  @Get('preferences')
  @Authenticated()
  getPreferences() {
    return notImplemented('SUP-03');
  }

  @Put('preferences')
  @Authenticated()
  updatePreferences(@Body() _body: unknown) {
    return notImplemented('SUP-03');
  }
}
