import { Module } from '@nestjs/common';
import {
  ApprovalIntegrationController,
  ApprovalMatrixAdminController,
  ApprovalsController,
} from './approvals.controller';

/** S2. */
@Module({
  controllers: [
    ApprovalsController,
    ApprovalMatrixAdminController,
    ApprovalIntegrationController,
  ],
})
export class ApprovalsModule {}
