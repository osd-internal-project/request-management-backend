import { Module } from '@nestjs/common';
import { AgentRecordsModule } from '@request-management/core-service';
import { ExternalAgentRecordsController } from './agent-records.controller';

/** `api/v1/agent-records/*` — an external agent closes the job it was handed. */
@Module({
  imports: [AgentRecordsModule],
  controllers: [ExternalAgentRecordsController],
})
export class AgentRecordsApiModule {}
