import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { LeadRepository } from '../crm/sales.repositories';
import { AgentRecordRepository } from './agent-record.repository';
import { AgentRecordsService } from './agent-records.service';
import { IntegrationEndpointRepository } from './integration-endpoint.repository';
import { VuvagentClient } from './vuvagent.client';

/** งานของ AI agent ภายนอก — domain half; external-service imports this for the callback. */
@Module({
  imports: [AccessModule],
  providers: [
    AgentRecordRepository,
    IntegrationEndpointRepository,
    // only to list the leads an agent created for a record
    LeadRepository,
    AgentRecordsService,
    VuvagentClient,
  ],
  exports: [
    AgentRecordRepository,
    IntegrationEndpointRepository,
    AgentRecordsService,
  ],
})
export class AgentRecordsModule {}
