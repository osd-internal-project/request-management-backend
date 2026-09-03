import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  CurrentPrincipal,
  Permissions,
  Public,
  resolveTargetCompany,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import { WorkflowService } from './workflow.service';
import { WorkflowRuntimeService } from './workflow-runtime.service';
import { WorkflowCallbackGuard } from './workflow-callback.guard';
import {
  CreateWorkflowDto,
  SaveWorkflowGraphDto,
  WorkflowCallbackDto,
} from './dto/workflow.dto';

/**
 * The หน้า Set Workflow behind the screen: states, the buttons out of each,
 * and the data flow between them.
 *
 * `admin.workflow.manage` rather than `admin.request-type.manage`: that
 * permission edits what a type asks for, this one edits how work moves.
 * Publishing re-routes every request raised afterwards, which is a larger
 * thing to hand somebody than adding a field to a form.
 */
@ApiTags('admin/workflow')
@ApiBearerAuth()
@Controller('admin/workflow')
export class WorkflowAdminController {
  constructor(private readonly workflow: WorkflowService) {}

  @Get()
  @Permissions('admin.workflow.manage')
  list(
    @CurrentPrincipal() principal: Principal,
    @Query('company_id') companyId?: string,
    @Query('request_type_id') requestTypeId?: string,
  ) {
    return this.workflow.list(
      resolveTargetCompany(principal, companyId),
      requestTypeId,
    );
  }

  @Get(':id')
  @Permissions('admin.workflow.manage')
  findOne(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.workflow.findOne(id, principal);
  }

  /** Opens the next draft version for a type. */
  @Post()
  @Permissions('admin.workflow.manage')
  create(
    @Body() dto: CreateWorkflowDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.workflow.create(dto, principal);
  }

  /** Replaces the whole graph of a draft — see `saveGraph`. */
  @Put(':id/graph')
  @Permissions('admin.workflow.manage')
  saveGraph(
    @Param('id') id: string,
    @Body() dto: SaveWorkflowGraphDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.workflow.saveGraph(id, dto, principal);
  }

  /**
   * Validates, generates the BPMN, deploys it, marks the version published.
   *
   * There is no update or delete route for a published version on purpose: a
   * request already running keeps the route it started on.
   */
  @Post(':id/publish')
  @Permissions('admin.workflow.manage')
  publish(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.workflow.publish(id, principal);
  }
}

/**
 * The route the workflow engine writes through.
 *
 * `@Public()` bypasses the guard chain because Flowable holds no Keycloak
 * token — `WorkflowCallbackGuard` demands a shared secret instead, and the
 * reasoning for that trade is on the guard.
 *
 * Nothing here decides who may do anything. Authority was checked in
 * `WorkflowRuntimeService.perform` before the task was completed, using the
 * same `hasAuthority` every other path uses; this applies a move the engine
 * has already made.
 */
@ApiTags('internal/workflow')
@Controller('internal/workflow')
export class WorkflowCallbackController {
  constructor(private readonly runtime: WorkflowRuntimeService) {}

  @Post('callback')
  @Public()
  @UseGuards(WorkflowCallbackGuard)
  callback(@Body() dto: WorkflowCallbackDto) {
    return this.runtime.applyCallback(dto);
  }
}
