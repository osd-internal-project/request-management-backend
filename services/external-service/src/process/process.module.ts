import { Module } from '@nestjs/common';
import { ProcessLogModule } from '@request-management/core-service';
import {
  ExternalProcessLogController,
  ExternalProcessRefsController,
} from './process.controller';

/** `api/v1/process/*` — the End-to-End process log and the deal's document numbers, for OSD Workflow. */
@Module({
  imports: [ProcessLogModule],
  controllers: [ExternalProcessLogController, ExternalProcessRefsController],
})
export class ProcessApiModule {}
