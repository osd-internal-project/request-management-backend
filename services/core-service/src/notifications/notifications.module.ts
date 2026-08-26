import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { LoggingEmailTransport } from './notification-transport';

/** SUP-03 minimum, behind an interface the full service can replace (D-34). */
@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService, LoggingEmailTransport],
  exports: [NotificationsService],
})
export class NotificationsModule {}
