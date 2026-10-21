import { Module } from '@nestjs/common';
import { ProcessLogModule } from '@request-management/core-service';
import { ExternalProcessLogController } from './process.controller';

/** `api/v1/process/*` — the End-to-End process log, written by OSD Workflow. */
@Module({
  imports: [ProcessLogModule],
  controllers: [ExternalProcessLogController],
})
export class ProcessApiModule {}
