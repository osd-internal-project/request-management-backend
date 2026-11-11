import { Module } from '@nestjs/common';
import { CrmModule } from '../crm/crm.module';
import { LeadFilesModule } from '../crm/lead-files.module';
import { EventsModule } from '../events/events.module';
import { LlmModule } from '../llm/llm.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { CrmEmailRepository } from './crm-email.repository';
import { MailClientsService } from './mail-clients.service';
import { MailSettingRepository } from './mail-setting.repository';
import { MailSettingsService } from './mail-settings.service';
import { SalesMailPollerService } from './sales-mail-poller.service';
import { SalesMailService } from './sales-mail.service';
import { SalesAutomationIssueRepository } from './sales-automation-issue.repository';
import { SalesAutomationService } from './sales-automation.service';
import {
  WorkflowStartRepository,
  WorkflowTriggerRepository,
} from '../workflow-trigger/workflow-trigger.repository';

/**
 * งานขายอัตโนมัติ (5 พ.ย. 2569) — the sales mailbox, per company: set on the
 * settings screen (`mail_settings`), else `MAIL_*` from env. Env `graph` with
 * missing values still refuses to boot.
 */
@Module({
  imports: [
    CrmModule,
    LeadFilesModule,
    LlmModule,
    NotificationsModule,
    EventsModule,
  ],
  providers: [
    CrmEmailRepository,
    MailSettingRepository,
    MailClientsService,
    MailSettingsService,
    SalesMailService,
    SalesMailPollerService,
    // why a sales workflow did not run (11 พ.ย. 2569) — reads the trigger
    // tables directly rather than importing the dispatcher's module
    SalesAutomationIssueRepository,
    SalesAutomationService,
    WorkflowTriggerRepository,
    WorkflowStartRepository,
  ],
  exports: [SalesMailService, MailSettingsService, SalesAutomationService],
})
export class MailModule {}
