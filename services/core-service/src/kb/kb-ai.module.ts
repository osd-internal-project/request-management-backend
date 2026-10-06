import { Module } from '@nestjs/common';
import { CrmModule } from '../crm/crm.module';
import {
  KbAiCitationRepository,
  KbAiQueryRepository,
  KbAiSearchRepository,
} from './kb-ai.repositories';
import { KbAiService } from './kb-ai.service';
import { KbSemanticModule } from './kb-semantic.module';

/**
 * CD-265 — the knowledge base for AI channels. No controllers and no
 * storage: external-service imports it to serve AI CARE / AI SMART
 * (`api/v1/kb/ai/*`), core-service for the knowledge owners' log.
 */
@Module({
  imports: [CrmModule, KbSemanticModule],
  providers: [
    KbAiService,
    KbAiQueryRepository,
    KbAiCitationRepository,
    KbAiSearchRepository,
  ],
  // CD-266 — the gap sweep reads unanswered questions
  exports: [KbAiService, KbAiQueryRepository],
})
export class KbAiModule {}
