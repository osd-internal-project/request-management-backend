import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  CurrentPrincipal,
  PageQueryDto,
  Permissions,
  resolveTargetCompany,
  SensitiveResource,
  ServiceAccountOnly,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import { ApprovalsService } from './approvals.service';
import { ApprovalMatrixService } from './approval-matrix.service';
import { DelegationsService } from './delegations.service';
import {
  BatchDecideDto,
  CreateDelegationDto,
  DecideDto,
  OpenCaseDto,
  PublishMatrixDto,
} from './dto/approval.dto';

/**
 * §11.5 group D — the central Approval Engine (S2).
 *
 * D-31 makes this callable by any module, not just Platform Request: see
 * `ApprovalIntegrationController`, which raises a case with no request record
 * behind it. The chain rules live in `approval-chain.ts`.
 */
@ApiTags('approvals')
@ApiBearerAuth()
@Controller('approvals')
export class ApprovalsController {
  constructor(
    private readonly approvals: ApprovalsService,
    private readonly delegations: DelegationsService,
  ) {}

  @Get('inbox')
  @Permissions('approval.decide')
  inbox(
    @CurrentPrincipal() principal: Principal,
    @Query() query: PageQueryDto,
  ) {
    return this.approvals.inbox(principal, query);
  }

  // Declared before ':caseId' so the literal path is not swallowed by the
  // parameter route.
  @Get('delegations')
  @Permissions('approval.delegate')
  listDelegations(@CurrentPrincipal() principal: Principal) {
    return this.delegations.list(principal);
  }

  @Post('delegations')
  @Permissions('approval.delegate')
  createDelegation(
    @Body() dto: CreateDelegationDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.delegations.create(dto, principal);
  }

  @Delete('delegations/:id')
  @Permissions('approval.delegate')
  @HttpCode(HttpStatus.NO_CONTENT)
  revokeDelegation(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.delegations.revoke(id, principal);
  }

  @Get('history')
  @Permissions('approval.history.read')
  history(
    @CurrentPrincipal() principal: Principal,
    @Query() query: PageQueryDto,
    @Query('subject_type') subjectType?: string,
  ) {
    return this.approvals.history(principal, query, subjectType);
  }

  @Post('batch-decide')
  @Permissions('approval.decide')
  batchDecide(
    @Body() dto: BatchDecideDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.approvals.batchDecide(dto, principal);
  }

  /**
   * §8 requires the decision view to show the margin **only if permitted** —
   * the masking is declared here rather than filtered by hand, so the field
   * never leaves the process for a caller without `request.sensitive.read`.
   */
  @Get(':caseId')
  @Permissions('approval.decide')
  @SensitiveResource('request:DSC')
  findOne(
    @Param('caseId') caseId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.approvals.findOne(caseId, principal);
  }

  @Post(':caseId/decide')
  @Permissions('approval.decide')
  decide(
    @Param('caseId') caseId: string,
    @Body() dto: DecideDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.approvals.decide(caseId, dto, principal);
  }
}

/** §11.5 authority-matrix administration (§16 A1). */
@ApiTags('admin/approval-matrix')
@ApiBearerAuth()
@Controller('admin/approval-matrix')
export class ApprovalMatrixAdminController {
  constructor(private readonly matrix: ApprovalMatrixService) {}

  @Get()
  @Permissions('admin.approval-matrix.manage')
  list(
    @CurrentPrincipal() principal: Principal,
    @Query('company_id') companyId?: string,
    @Query('subject_type') subjectType?: string,
  ) {
    return this.matrix.list(
      resolveTargetCompany(principal, companyId),
      subjectType,
    );
  }

  /**
   * Publishes the next version. There is no update or delete route on purpose
   * — a published ladder is immutable so that work already in flight keeps the
   * ceilings it was routed under.
   */
  @Post()
  @Permissions('admin.approval-matrix.manage')
  publishVersion(
    @Body() dto: PublishMatrixDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.matrix.publish(dto, principal);
  }
}

/** APV-07: other modules raise approvals without a Platform Request. */
@ApiTags('integrations')
@ApiBearerAuth()
@Controller('integrations/approval-cases')
export class ApprovalIntegrationController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Post()
  @Permissions('integration.approval.create')
  @ServiceAccountOnly()
  create(
    @Body() dto: OpenCaseDto,
    @CurrentPrincipal() principal: Principal,
    @Headers('authorization') authorization: string,
  ) {
    return this.approvals.openCase(dto, principal, authorization);
  }
}
