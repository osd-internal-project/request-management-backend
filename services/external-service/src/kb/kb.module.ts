import { Module } from '@nestjs/common';
import { KbAiModule } from '@request-management/core-service';
import { AuthModule } from '../auth/auth.module';
import { KbAiController } from './kb-ai.controller';

/** `api/v1/kb/ai/*` — CD-265, AI channels reading the knowledge base. */
@Module({
  imports: [KbAiModule, AuthModule],
  controllers: [KbAiController],
})
export class KbApiModule {}
