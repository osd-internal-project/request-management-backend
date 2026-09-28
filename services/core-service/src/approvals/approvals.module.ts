import { Module } from '@nestjs/common';
import { PrismaTransactionService } from '@request-management/share';
import { ApprovalsService } from './approvals.service';
import { ApprovalMatrixService } from './approval-matrix.service';
import { DelegationsService } from './delegations.service';
import { ApprovalCaseRepository } from './approval-case.repository';
import { ApprovalMatrixRepository } from './approval-matrix.repository';
import { DelegationRepository } from './delegation.repository';
import { PrincipalModule } from '../principal/principal.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AccessModule } from '../access/access.module';
import { RequestFlowModule } from '../request-flow/request-flow.module';
import { SlaModule } from '../sla/sla.module';

/** S2 — the central Approval Engine (D-31). */
@Module({
  imports: [
    AccessModule,
    PrincipalModule,
    NotificationsModule,
    RequestFlowModule,
    SlaModule,
  ],
  providers: [
    ApprovalsService,
    ApprovalMatrixService,
    DelegationsService,
    ApprovalCaseRepository,
    ApprovalMatrixRepository,
    DelegationRepository,
    PrismaTransactionService,
  ],
  /*
    `ApprovalMatrixService` and `DelegationsService` are exported for
    `ApprovalsHttpModule`, which owns the controllers that inject them.
  */
  exports: [ApprovalsService, ApprovalMatrixService, DelegationsService],
})
export class ApprovalsModule {}
