import { Module } from '@nestjs/common';
import { RequestsModule } from './requests.module';
import { AttachmentsModule } from './attachments.module';
import {
  RequestsController,
  RequestTypeAdminController,
} from './requests.controller';

/**
 * The screen-facing routes of {@link RequestsModule}. See `src/index.ts` for
 * why routes and providers are separate modules.
 */
@Module({
  imports: [RequestsModule, AttachmentsModule],
  controllers: [RequestsController, RequestTypeAdminController],
})
export class RequestsHttpModule {}
