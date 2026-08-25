import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Permissions } from '@request-management/share';
import { notImplemented } from '../common/not-implemented';

/**
 * §11.5 group D — the central Approval Engine. Delivered in **S2**.
 *
 * D-31 makes this callable by any module, not just Platform Request: see
 * `POST /integrations/approval-cases`, which raises a case with no request
 * record behind it. The chain rules live in `approval-chain.ts`.
 */
@ApiTags('approvals')
@ApiBearerAuth()
@Controller('approvals')
export class ApprovalsController {
  @Get('inbox')
  @Permissions('approval.decide')
  inbox(@Query() _query: unknown) {
    return notImplemented('APV-02');
  }

  @Get(':caseId')
  @Permissions('approval.decide')
  findOne(@Param('caseId') _caseId: string) {
    return notImplemented('APV-02');
  }

  /** Decision is bound to the snapshot version it was made against (APV-05). */
  @Post(':caseId/decide')
  @Permissions('approval.decide')
  decide(@Param('caseId') _caseId: string, @Body() _body: unknown) {
    return notImplemented('APV-05');
  }

  @Post('batch-decide')
  @Permissions('approval.decide')
  batchDecide(@Body() _body: unknown) {
    return notImplemented('APV-04');
  }

  @Get('delegations')
  @Permissions('approval.delegate')
  listDelegations() {
    return notImplemented('APV-03');
  }

  @Post('delegations')
  @Permissions('approval.delegate')
  createDelegation(@Body() _body: unknown) {
    return notImplemented('APV-03');
  }

  @Delete('delegations/:id')
  @Permissions('approval.delegate')
  revokeDelegation(@Param('id') _id: string) {
    return notImplemented('APV-03');
  }

  @Get('history')
  @Permissions('approval.history.read')
  history(@Query() _query: unknown) {
    return notImplemented('APV-06');
  }
}

/** §11.5 approval-matrix administration (screen A1). */
@ApiTags('admin/approval-matrix')
@ApiBearerAuth()
@Controller('admin/approval-matrix')
export class ApprovalMatrixAdminController {
  @Get()
  @Permissions('admin.approval-matrix.manage')
  list(@Query('company_id') _companyId?: string) {
    return notImplemented('APV-01');
  }

  /** Publishing always creates a new version; APV-01 forbids editing in place. */
  @Post()
  @Permissions('admin.approval-matrix.manage')
  publishVersion(@Body() _body: unknown) {
    return notImplemented('APV-01');
  }
}

/** APV-07: other modules raise approvals without a Platform Request. */
@ApiTags('integrations')
@ApiBearerAuth()
@Controller('integrations/approval-cases')
export class ApprovalIntegrationController {
  @Post()
  @Permissions('integration.approval.create')
  create(@Body() _body: unknown) {
    return notImplemented('APV-07');
  }
}
