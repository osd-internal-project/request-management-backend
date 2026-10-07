import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module';
import { KbSemanticService } from './kb-semantic.service';
import { KbChunkRepository } from './kb.repositories';

/**
 * CD-267 — searching the knowledge base by meaning, shared by the staff
 * search and the portal (KbModule) and the AI channels (KbAiModule). No
 * controllers; the embedding sweep runs where `kb.embedIntervalMs` is set
 * (core-service only).
 */
@Module({
  imports: [LlmModule],
  providers: [KbSemanticService, KbChunkRepository],
  exports: [KbSemanticService],
})
export class KbSemanticModule {}
