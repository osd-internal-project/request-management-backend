import { Module } from '@nestjs/common';
import { PrismaTransactionService } from '@request-management/share';
import {
  ApprovalIntegrationController,
  ApprovalMatrixAdminController,
  ApprovalsController,
} from './approvals.controller';
import { ApprovalsService } from './approvals.service';
import { ApprovalMatrixService } from './approval-matrix.service';
import { DelegationsService } from './delegations.service';
import { ApprovalCaseRepository } from './approval-case.repository';
import { ApprovalMatrixRepository } from './approval-matrix.repository';
import { DelegationRepository } from './delegation.repository';
import { PrincipalModule } from '../principal/principal.module';
import { NotificationsModule } from '../notifications/notifications.module';

/** S2 — the central Approval Engine (D-31). */
@Module({
  imports: [PrincipalModule, NotificationsModule],
  controllers: [
    ApprovalsController,
    ApprovalMatrixAdminController,
    ApprovalIntegrationController,
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
  exports: [ApprovalsService],
})
export class ApprovalsModule {}
