import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  PrismaTransactionService,
  StorageModule,
  type StorageOptions,
} from '@request-management/share';
import { AttachmentRepository } from './attachment.repository';
import { AttachmentsService } from './attachments.service';
import { RequestsModule } from './requests.module';

/**
 * REQ-03 file storage. Imported by the HTTP half only, so external-service,
 * which never serves attachments, needs no storage config to boot.
 */
@Module({
  imports: [
    RequestsModule,
    StorageModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        config.get<StorageOptions>('storage'),
    }),
  ],
  providers: [AttachmentsService, AttachmentRepository, PrismaTransactionService],
  exports: [AttachmentsService],
})
export class AttachmentsModule {}
