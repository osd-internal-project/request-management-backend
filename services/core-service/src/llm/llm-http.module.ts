import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { LlmAdminService } from './llm-admin.service';
import { LlmController } from './llm.controller';
import { LlmModule } from './llm.module';

/** The screen-facing routes of {@link LlmModule}. */
@Module({
  imports: [LlmModule, AccessModule],
  controllers: [LlmController],
  providers: [LlmAdminService],
})
export class LlmHttpModule {}
