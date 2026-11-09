import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { CrmModule } from '../crm/crm.module';
import { LeadFilesModule } from '../crm/lead-files.module';
import { AgentRecordRepository } from './agent-record.repository';
import { AgentRecordsService } from './agent-records.service';
import { OutboundConnectionRepository } from './outbound-connection.repository';
import { VuvagentClient } from './vuvagent.client';

/** งานของ AI agent ภายนอก — domain half; external-service imports this for the callback. */
@Module({
  imports: [AccessModule, CrmModule, LeadFilesModule],
  providers: [
    AgentRecordRepository,
    OutboundConnectionRepository,
    AgentRecordsService,
    VuvagentClient,
  ],
  exports: [
    VuvagentClient,
    AgentRecordRepository,
    OutboundConnectionRepository,
    AgentRecordsService,
  ],
})
export class AgentRecordsModule {}
