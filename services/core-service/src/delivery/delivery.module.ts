import { Module } from '@nestjs/common';
import { PmModule } from '../pm/pm.module';
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
  imports: [PmModule],
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
  ],
  exports: [
    DeliveriesService,
    DeliveryDocsState,
    ProjectDeliveryDocumentRepository,
    ProjectInstallConfirmationRepository,
    ProjectDeliveryRepository,
    DeliveryPeopleRepository,
  ],
})
export class DeliveryModule {}
