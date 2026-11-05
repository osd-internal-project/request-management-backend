import { Module } from '@nestjs/common';
import { MailModule } from './mail.module';
import { SalesMailController } from './sales-mail.controller';

@Module({
  imports: [MailModule],
  controllers: [SalesMailController],
})
export class MailHttpModule {}
