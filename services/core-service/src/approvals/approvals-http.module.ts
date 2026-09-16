import { Module } from '@nestjs/common';
import { ApprovalsModule } from './approvals.module';
import {
  ApprovalMatrixAdminController,
  ApprovalsController,
} from './approvals.controller';

/**
 * The screen-facing routes of {@link ApprovalsModule}, kept apart from the
 * providers so that importing the domain does not import the routes.
 *
 * See `src/index.ts` for why that separation exists and what depends on it.
 *
 * `ApprovalIntegrationController` used to be here as well. APV-07's route is
 * now `POST api/v1/approval/cases` on external-service, with the rest of the
 * outward-facing surface.
 */
@Module({
  imports: [ApprovalsModule],
  controllers: [ApprovalsController, ApprovalMatrixAdminController],
})
export class ApprovalsHttpModule {}
