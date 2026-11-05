import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CrmModule } from '../crm/crm.module';
import { EventsModule } from '../events/events.module';
import { LlmModule } from '../llm/llm.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { CrmEmailRepository } from './crm-email.repository';
import { GraphMailClient, type GraphMailSettings } from './graph-mail.client';
import { MAIL_CLIENT, type MailClient } from './mail-client';
import { MockMailClient } from './mock-mail.client';
import { SalesMailPollerService } from './sales-mail-poller.service';
import { SalesMailService } from './sales-mail.service';

/**
 * งานขายอัตโนมัติ (5 พ.ย. 2569) — the sales mailbox. `MAIL_MODE=off` (default)
 * provides no client: sending answers 409 and nothing polls. `graph` refuses
 * to boot without its settings rather than failing every send later.
 */
@Module({
  imports: [CrmModule, LlmModule, NotificationsModule, EventsModule],
  providers: [
    GraphMailClient,
    {
      provide: MAIL_CLIENT,
      inject: [ConfigService, GraphMailClient],
      useFactory: (
        config: ConfigService,
        graph: GraphMailClient,
      ): MailClient | null => {
        const mode = config.get<string>('mail.mode') ?? 'off';
        const mailbox = config.get<string>('mail.mailbox') ?? '';
        if (mode === 'off') return null;
        if (mode === 'mock') {
          return new MockMailClient(mailbox || 'sales@mock.local');
        }
        if (mode === 'graph') {
          const missing = GraphMailClient.missingSettings(
            mailbox,
            config.get<GraphMailSettings>('mail.graph'),
          );
          if (missing.length) {
            throw new Error(`MAIL_MODE=graph needs ${missing.join(', ')}`);
          }
          new Logger('MailModule').log(
            `mailbox ${mailbox} via Microsoft Graph`,
          );
          return graph;
        }
        throw new Error(`MAIL_MODE must be off, mock or graph (got ${mode})`);
      },
    },
    CrmEmailRepository,
    SalesMailService,
    SalesMailPollerService,
  ],
  exports: [SalesMailService],
})
export class MailModule {}
