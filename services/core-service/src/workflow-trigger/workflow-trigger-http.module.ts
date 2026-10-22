import { Module } from '@nestjs/common';
import { WorkflowTriggerModule } from './workflow-trigger.module';
import { WorkflowTriggerAdminController } from './workflow-trigger-admin.controller';
import { WorkflowTriggerAdminService } from './workflow-trigger-admin.service';

/** The admin screen's routes; internal port only (see `src/index.ts`). */
@Module({
  imports: [WorkflowTriggerModule],
  controllers: [WorkflowTriggerAdminController],
  providers: [WorkflowTriggerAdminService],
})
export class WorkflowTriggerHttpModule {}
