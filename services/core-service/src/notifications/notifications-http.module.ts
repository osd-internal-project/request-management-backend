import { Module } from '@nestjs/common';
import { NotificationsModule } from './notifications.module';
import { NotificationsController } from './notifications.controller';
import { NotificationLogService } from './notification-log.service';

/**
 * The screen-facing routes of {@link NotificationsModule}. See `src/index.ts`
 * for why routes and providers are separate modules.
 */
@Module({
  imports: [NotificationsModule],
  controllers: [NotificationsController],
  // Only the screen reads the log — external-service has no use for it.
  providers: [NotificationLogService],
})
export class NotificationsHttpModule {}
