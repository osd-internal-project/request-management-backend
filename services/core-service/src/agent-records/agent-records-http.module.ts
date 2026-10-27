import { Module } from '@nestjs/common';
import { AgentRecordsModule } from './agent-records.module';
import {
  AgentRecordsController,
  LeadFindController,
} from './agent-records.controller';
import { IntegrationEndpointsAdminController } from './integration-endpoints-admin.controller';
import { IntegrationEndpointsAdminService } from './integration-endpoints-admin.service';

/** The screens' routes; internal port only (see `src/index.ts`). */
@Module({
  imports: [AgentRecordsModule],
  controllers: [
    AgentRecordsController,
    LeadFindController,
    IntegrationEndpointsAdminController,
  ],
  providers: [IntegrationEndpointsAdminService],
})
export class AgentRecordsHttpModule {}
