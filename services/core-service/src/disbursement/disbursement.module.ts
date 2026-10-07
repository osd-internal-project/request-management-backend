import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../approvals/approvals.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RequestsModule } from '../requests/requests.module';
import { RunNumberClientModule } from '../run-number/run-number-client.module';
import { DisbursementRequestSyncService } from './disbursement-request-sync.service';
import { DisbursementsService } from './disbursements.service';
import { PettyCashService } from './petty-cash.service';
import {
  DisbursementFileRepository,
  DisbursementLineRepository,
  DisbursementMovementRepository,
  DisbursementRepository,
  DisbursementSettingsRepository,
  PettyCashFundRepository,
  PettyCashReplenishmentRepository,
} from './disbursement.repositories';

/** การเบิก — advances and petty cash, raised through requests (docs/disbursement.md). */
@Module({
  imports: [
    RequestsModule,
    ApprovalsModule,
    NotificationsModule,
    RunNumberClientModule,
  ],
  providers: [
    DisbursementsService,
    DisbursementRequestSyncService,
    PettyCashService,
    DisbursementRepository,
    DisbursementFileRepository,
    DisbursementLineRepository,
    DisbursementMovementRepository,
    DisbursementSettingsRepository,
    PettyCashFundRepository,
    PettyCashReplenishmentRepository,
  ],
  exports: [
    DisbursementsService,
    DisbursementFileRepository,
    PettyCashService,
  ],
})
export class DisbursementModule {}
