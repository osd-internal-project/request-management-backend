import { Module } from '@nestjs/common';
import {
  WorkflowAdminController,
  WorkflowCallbackController,
} from './workflow.controller';
import { WorkflowService } from './workflow.service';
import { WorkflowRuntimeService } from './workflow-runtime.service';
import { WorkflowCallbackGuard } from './workflow-callback.guard';
import { FlowableClient } from './flowable.client';
import {
  WorkflowActionRepository,
  WorkflowInstanceRepository,
  WorkflowRepository,
  WorkflowStateRepository,
} from './workflow.repository';

/**
 * Routes as configuration — the states a request type travels, the buttons out
 * of each, and the data flow between them.
 *
 * Built alongside §7.1's state machine rather than on top of it: every type
 * carries `workflowMode = legacy` until somebody switches it, so nothing here
 * changes how an existing request behaves.
 */
@Module({
  controllers: [WorkflowAdminController, WorkflowCallbackController],
  providers: [
    WorkflowService,
    WorkflowRuntimeService,
    WorkflowCallbackGuard,
    FlowableClient,
    WorkflowRepository,
    WorkflowStateRepository,
    WorkflowActionRepository,
    WorkflowInstanceRepository,
  ],
  exports: [
    WorkflowService,
    WorkflowRuntimeService,
    FlowableClient,
    WorkflowActionRepository,
    WorkflowInstanceRepository,
  ],
})
export class WorkflowModule {}
