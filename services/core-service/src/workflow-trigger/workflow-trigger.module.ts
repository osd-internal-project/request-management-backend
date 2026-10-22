import { Module } from '@nestjs/common';
import { LeadRepository } from '../crm/sales.repositories';
import { WorkflowModule } from '../workflow/workflow.module';
import { WorkflowTriggerDispatchService } from './workflow-trigger-dispatch.service';
import {
  WorkflowStartRepository,
  WorkflowTriggerRepository,
} from './workflow-trigger.repository';

/** เหตุการณ์ → workflow — domain half: queue on every event, start on core-service's clock. */
@Module({
  imports: [WorkflowModule],
  providers: [
    WorkflowTriggerRepository,
    WorkflowStartRepository,
    // only to keep `leads.workflowInstanceId` for a lead started from here
    LeadRepository,
    WorkflowTriggerDispatchService,
  ],
  exports: [
    WorkflowTriggerRepository,
    WorkflowStartRepository,
    WorkflowTriggerDispatchService,
  ],
})
export class WorkflowTriggerModule {}
