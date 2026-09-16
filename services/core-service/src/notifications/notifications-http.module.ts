import { Module } from '@nestjs/common';
import { NotificationsModule } from './notifications.module';
import { NotificationsController } from './notifications.controller';

/**
 * The screen-facing routes of {@link NotificationsModule}. See `src/index.ts`
 * for why routes and providers are separate modules.
 */
@Module({
  imports: [NotificationsModule],
  controllers: [NotificationsController],
})
export class NotificationsHttpModule {}
