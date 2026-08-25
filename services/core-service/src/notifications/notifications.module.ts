import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';

/** S2 — in-app plus SMTP, the minimum from §09. */
@Module({
  controllers: [NotificationsController],
})
export class NotificationsModule {}
