import { Module } from '@nestjs/common';
import { AgentRecordsModule } from './agent-records.module';
import {
  AgentRecordsController,
  LeadFindController,
} from './agent-records.controller';
import { AgentRecordTimeoutService } from './agent-record-timeout.service';
import { OutboundConnectionsAdminController } from './outbound-connections-admin.controller';
import { OutboundConnectionsAdminService } from './outbound-connections-admin.service';

/** The screens' routes; internal port only (see `src/index.ts`). */
@Module({
  imports: [AgentRecordsModule],
  controllers: [
    AgentRecordsController,
    LeadFindController,
    OutboundConnectionsAdminController,
  ],
  // the sweep sits here so only core-service runs it, not external-service
  providers: [OutboundConnectionsAdminService, AgentRecordTimeoutService],
})
export class AgentRecordsHttpModule {}
