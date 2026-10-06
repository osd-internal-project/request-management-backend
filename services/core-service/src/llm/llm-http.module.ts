import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { AiAuditController } from './ai-audit.controller';
import { AiAuditService } from './ai-audit.service';
import { LlmAdminService } from './llm-admin.service';
import { LlmController } from './llm.controller';
import { LlmModule } from './llm.module';

/** The screen-facing routes of {@link LlmModule}. */
@Module({
  imports: [LlmModule, AccessModule],
  controllers: [LlmController, AiAuditController],
  // CD-279 — the AI audit log's screen and its retention sweep
  providers: [LlmAdminService, AiAuditService],
})
export class LlmHttpModule {}
