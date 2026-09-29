import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationsService } from './notifications.service';
import { LoggingEmailTransport } from './notification-transport';
import { NotificationRulesService } from './notification-rules.service';
import { MockTeamsClient } from './teams/mock-teams.client';
import {
  BotFrameworkTeamsClient,
  type TeamsBotSettings,
} from './teams/teams-botframework.client';
import { TEAMS_CLIENT } from './teams/teams-client';
import { TeamsDeliveryService } from './teams/teams-delivery.service';

/** SUP-03 minimum, behind an interface the full service can replace (D-34). */
@Module({
  providers: [
    NotificationsService,
    LoggingEmailTransport,
    NotificationRulesService,
    MockTeamsClient,
    BotFrameworkTeamsClient,
    {
      // CD-51 — null when TEAMS_MODE is off: the channel does not exist.
      provide: TEAMS_CLIENT,
      inject: [ConfigService, MockTeamsClient, BotFrameworkTeamsClient],
      useFactory: (
        config: ConfigService,
        mock: MockTeamsClient,
        bot: BotFrameworkTeamsClient,
      ) => {
        const mode = config.get<string>('teams.mode') ?? 'off';
        if (mode === 'off') return null;
        if (mode === 'mock') return mock;
        if (mode === 'botframework') {
          // Fail at boot, loudly: half a config would fail every send quietly.
          const missing = BotFrameworkTeamsClient.missingSettings(
            config.get<TeamsBotSettings>('teams.bot'),
          );
          if (missing.length) {
            throw new Error(
              `TEAMS_MODE=botframework แต่ยังไม่ได้ตั้ง ${missing.join(', ')}`,
            );
          }
          return bot;
        }
        throw new Error(
          `TEAMS_MODE=${mode} ไม่รู้จัก — ใช้ off, mock หรือ botframework`,
        );
      },
    },
    TeamsDeliveryService,
  ],
  exports: [NotificationsService, NotificationRulesService],
})
export class NotificationsModule {}
