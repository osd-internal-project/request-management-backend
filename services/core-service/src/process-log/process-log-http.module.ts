import { Module } from '@nestjs/common';
import { ProcessLogController } from './process-log.controller';
import { ProcessLogModule } from './process-log.module';

/** The screen's routes; internal port only (see `src/index.ts`). */
@Module({
  imports: [ProcessLogModule],
  controllers: [ProcessLogController],
})
export class ProcessLogHttpModule {}
