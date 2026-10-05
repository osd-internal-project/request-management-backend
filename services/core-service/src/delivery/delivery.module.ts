import { Module } from '@nestjs/common';
import { PmModule } from '../pm/pm.module';
import { ErpModule } from '../erp/erp.module';
import { InstallmentBillingService } from './installment-billing.service';
import { InstallmentErpSyncService } from './installment-erp-sync.service';
import { RetentionReminderService } from './retention-reminder.service';
import { ServiceHandoversService } from './service-handovers.service';
import { DeliveryReportService } from './delivery-report.service';
import { ReceivableReminderService } from './receivable-reminder.service';
import { DeliveriesService } from './deliveries.service';
import { DeliveryDocsState } from './delivery-docs.state';
import {
  DeliveryPeopleRepository,
  ProjectDeliveryLineRepository,
  ProjectDeliveryRepository,
  ProjectDeliveryDocumentRepository,
  ProjectInstallConfirmationRepository,
} from './delivery.repositories';

/**
 * CD-20 Delivery — ส่งมอบและตรวจรับ. Built on the project (PM, CD-18): its
 * milestones, its baseline BOQ, and who may see it.
 */
@Module({
  // CD-253 — the SAP client for installment invoices
  imports: [PmModule, ErpModule],
  providers: [
    // CD-250
    DeliveriesService,
    ProjectDeliveryRepository,
    ProjectDeliveryLineRepository,
    DeliveryPeopleRepository,
    // CD-251
    DeliveryDocsState,
    ProjectDeliveryDocumentRepository,
    // CD-254
    ProjectInstallConfirmationRepository,
    // CD-253
    InstallmentBillingService,
    InstallmentErpSyncService,
    RetentionReminderService,
    // CD-255
    ServiceHandoversService,
    // CD-256
    DeliveryReportService,
    ReceivableReminderService,
  ],
  exports: [
    DeliveriesService,
    ServiceHandoversService,
    DeliveryReportService,
    InstallmentBillingService,
    DeliveryDocsState,
    ProjectDeliveryDocumentRepository,
    ProjectInstallConfirmationRepository,
    ProjectDeliveryRepository,
    DeliveryPeopleRepository,
  ],
})
export class DeliveryModule {}
