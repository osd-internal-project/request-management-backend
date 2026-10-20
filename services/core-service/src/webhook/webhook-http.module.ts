import { Module } from '@nestjs/common';
import { WebhookModule } from './webhook.module';
import { WebhookAdminController } from './webhook-admin.controller';
import { WebhookAdminService } from './webhook-admin.service';

/** G-07 — the admin screen's routes; internal port only (see `src/index.ts`). */
@Module({
  imports: [WebhookModule],
  controllers: [WebhookAdminController],
  providers: [WebhookAdminService],
})
export class WebhookHttpModule {}
