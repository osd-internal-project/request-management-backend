import { Module } from '@nestjs/common';
import { KbAiModule } from '../kb/kb-ai.module';
import { LlmModule } from '../llm/llm.module';
import { SupportModule } from '../support/support.module';
import { ServiceAssetRepository } from '../support/support.repositories';
import {
  CareContactLookupRepository,
  CareConversationRepository,
  CareIdentityRepository,
  CareMessageRepository,
} from './care.repositories';
import { CareAnswerService } from './care-answer.service';
import { CareService } from './care.service';

/**
 * CD-23 AI CARE — conversations with existing customers on every channel.
 * No controllers: core-service serves the service team's screens
 * (CareHttpModule), external-service the channels and AI (`api/v1/care/*`).
 */
@Module({
  // CD-281 — answers from the knowledge base through the LLM Gateway
  imports: [SupportModule, KbAiModule, LlmModule],
  providers: [
    CareService,
    CareAnswerService,
    CareConversationRepository,
    CareMessageRepository,
    CareIdentityRepository,
    CareContactLookupRepository,
    ServiceAssetRepository,
  ],
  exports: [CareService],
})
export class CareModule {}
