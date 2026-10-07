import { Module } from '@nestjs/common';
import { CrmModule } from '../crm/crm.module';
import { RequestIntakeChannelRepository } from '../crm/customer-intake.repository';
import { CrmConfigRepository } from '../crm/segment.repositories';
import { KbAiModule } from '../kb/kb-ai.module';
import { RequestsModule } from '../requests/requests.module';
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
import { CareCaseService } from './care-case.service';
import { CareService } from './care.service';

/**
 * CD-23 AI CARE — conversations with existing customers on every channel.
 * No controllers: core-service serves the service team's screens
 * (CareHttpModule), external-service the channels and AI (`api/v1/care/*`).
 */
@Module({
  // CD-281 — answers from the knowledge base through the LLM Gateway
  // CD-282 — cases through the AI CARE intake channel, made service jobs
  imports: [SupportModule, KbAiModule, LlmModule, RequestsModule, CrmModule],
  providers: [
    CareService,
    CareAnswerService,
    CareCaseService,
    RequestIntakeChannelRepository,
    CrmConfigRepository,
    CareConversationRepository,
    CareMessageRepository,
    CareIdentityRepository,
    CareContactLookupRepository,
    ServiceAssetRepository,
  ],
  exports: [CareService],
})
export class CareModule {}
