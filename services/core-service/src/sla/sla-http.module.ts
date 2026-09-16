import { Module } from '@nestjs/common';
import { SlaModule } from './sla.module';
import { SlaController } from './sla.controller';

/**
 * The screen-facing routes of {@link SlaModule}. See `src/index.ts` for why
 * routes and providers are separate modules.
 */
@Module({
  imports: [SlaModule],
  controllers: [SlaController],
})
export class SlaHttpModule {}
