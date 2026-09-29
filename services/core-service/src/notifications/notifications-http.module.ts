import { Module } from '@nestjs/common';
import { NotificationsModule } from './notifications.module';
import { NotificationsController } from './notifications.controller';
import { NotificationLogService } from './notification-log.service';
import { NotificationDigestService } from './notification-digest.service';
import { NotificationTemplateAdminService } from './notification-template-admin.service';
import { NotificationTemplateController } from './notification-template.controller';
import { NotificationRuleAdminService } from './notification-rule-admin.service';
import { NotificationRuleController } from './notification-rule.controller';
import { PrismaTransactionService } from '@request-management/share';

/**
 * The screen-facing routes of {@link NotificationsModule}. See `src/index.ts`
 * for why routes and providers are separate modules.
 */
@Module({
  imports: [NotificationsModule],
  controllers: [
    NotificationsController,
    NotificationTemplateController,
    NotificationRuleController,
  ],
  // Only core-service reads the log and runs the digest schedule —
  // external-service imports the domain module, never this one.
  providers: [
    NotificationLogService,
    NotificationDigestService,
    NotificationTemplateAdminService,
    NotificationRuleAdminService,
    PrismaTransactionService,
  ],
})
export class NotificationsHttpModule {}
