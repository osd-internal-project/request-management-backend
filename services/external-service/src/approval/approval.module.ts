import { Module } from '@nestjs/common';
import { ApprovalsModule } from '@request-management/core-service';
import { ExternalApprovalController } from './approval.controller';

/**
 * `api/v1/approval/*` — the one approval verb an outside module needs.
 *
 * No `AuthModule`: this route has no acting user (the controller explains
 * why), so it needs neither the swap nor the second gate.
 */
@Module({
  imports: [ApprovalsModule],
  controllers: [ExternalApprovalController],
})
export class ApprovalModule {}
