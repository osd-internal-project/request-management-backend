import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { LoggingEmailTransport } from './notification-transport';

/** SUP-03 minimum, behind an interface the full service can replace (D-34). */
@Module({
  providers: [NotificationsService, LoggingEmailTransport],
  exports: [NotificationsService],
})
export class NotificationsModule {}
