import { Module } from '@nestjs/common';
import { SupportModule } from '../support/support.module';
import { ServiceAssetRepository } from '../support/support.repositories';
import {
  CareContactLookupRepository,
  CareConversationRepository,
  CareIdentityRepository,
  CareMessageRepository,
} from './care.repositories';
import { CareService } from './care.service';

/**
 * CD-23 AI CARE — conversations with existing customers on every channel.
 * No controllers: core-service serves the service team's screens
 * (CareHttpModule), external-service the channels and AI (`api/v1/care/*`).
 */
@Module({
  imports: [SupportModule],
  providers: [
    CareService,
    CareConversationRepository,
    CareMessageRepository,
    CareIdentityRepository,
    CareContactLookupRepository,
    ServiceAssetRepository,
  ],
  exports: [CareService],
})
export class CareModule {}
