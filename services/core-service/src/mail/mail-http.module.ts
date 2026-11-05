import { Module } from '@nestjs/common';
import { MailModule } from './mail.module';
import { MailSettingsController } from './mail-settings.controller';
import { SalesMailController } from './sales-mail.controller';

@Module({
  imports: [MailModule],
  controllers: [SalesMailController, MailSettingsController],
})
export class MailHttpModule {}
