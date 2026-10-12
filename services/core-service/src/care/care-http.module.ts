import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StorageModule, type StorageOptions } from '@request-management/share';
import { CareAttachmentsService } from './care-attachments.service';
import { CareController } from './care.controller';
import { CareModule } from './care.module';
import {
  CareContactLookupRepository,
  CareConversationRepository,
  CareMessageRepository,
} from './care.repositories';

/**
 * The screen-facing routes of {@link CareModule}, and (CD-285) the copying
 * of channel files into core-service's storage — external-service, where
 * the channels land, has none.
 */
@Module({
  imports: [
    CareModule,
    StorageModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        config.get<StorageOptions>('storage'),
    }),
  ],
  controllers: [CareController],
  providers: [
    CareAttachmentsService,
    CareMessageRepository,
    CareConversationRepository,
    CareContactLookupRepository,
  ],
})
export class CareHttpModule {}
