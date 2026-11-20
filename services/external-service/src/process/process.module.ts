import { Module } from '@nestjs/common';
import {
  AssignmentModule,
  LineModule,
  ProcessLogModule,
} from '@request-management/core-service';
import { ExternalAssignmentController } from './assignment.controller';
import {
  ExternalProcessLogController,
  ExternalProcessRefsController,
} from './process.controller';

/** `api/v1/process/*` — the End-to-End process log, the deal's document numbers and the team table, for OSD Workflow. */
@Module({
  imports: [ProcessLogModule, AssignmentModule, LineModule],
  controllers: [
    ExternalProcessLogController,
    ExternalProcessRefsController,
    ExternalAssignmentController,
  ],
})
export class ProcessApiModule {}
