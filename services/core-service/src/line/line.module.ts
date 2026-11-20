import { Module } from '@nestjs/common';
import { LineLinkService } from './line-link.service';
import { LineLoginClient } from './line-login.client';
import { LineSettingRepository } from './line-setting.repository';
import { LineSettingsService } from './line-settings.service';
import { UserLineAccountRepository } from './user-line-account.repository';

/** Each user's LINE per company, linked through the company's LINE Login channel. */
@Module({
  providers: [
    LineSettingRepository,
    UserLineAccountRepository,
    LineLoginClient,
    LineSettingsService,
    LineLinkService,
  ],
  exports: [LineLinkService, UserLineAccountRepository],
})
export class LineModule {}
