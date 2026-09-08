import { Module } from '@nestjs/common';
import { PrismaTransactionService } from '@request-management/share';
import { AccessModule } from '../access/access.module';
import { CustomersController } from './customers.controller';
import { CrmAdminController } from './crm-admin.controller';
import { CustomersService } from './customers.service';
import { CrmAdminService } from './crm-admin.service';
import { CustomerRepository } from './customer.repository';
import {
  CustomerLocationRepository,
  CustomerContactRepository,
  CustomerExternalCodeRepository,
  CustomerFieldChangeRepository,
} from './customer-child.repositories';
import {
  CrmConfigRepository,
  CustomerSegmentAssignmentRepository,
  CustomerSegmentDimensionRepository,
  CustomerSegmentValueRepository,
} from './segment.repositories';
import { CustomerCodeService } from './customer-code.service';
import { CustomerDedupService } from './customer-dedup.service';
import { CustomerTimelineService } from './customer-timeline.service';

/**
 * CRM ระยะ 1 — Customer Master (CD-59 / CM-01…09) + the parts of มุมมอง 360°
 * that live on the customer itself (CD-68 / C360-03 timeline).
 *
 * `CustomerTimelineService` is exported: it is the one interface other
 * modules (requests today; deals, cases later) publish customer-timeline
 * events through — nothing writes the table directly (C360-03).
 */
@Module({
  imports: [AccessModule],
  controllers: [CustomersController, CrmAdminController],
  providers: [
    CustomersService,
    CrmAdminService,
    CustomerRepository,
    CustomerLocationRepository,
    CustomerContactRepository,
    CustomerExternalCodeRepository,
    CustomerFieldChangeRepository,
    CustomerSegmentDimensionRepository,
    CustomerSegmentValueRepository,
    CustomerSegmentAssignmentRepository,
    CrmConfigRepository,
    CustomerCodeService,
    CustomerDedupService,
    CustomerTimelineService,
    PrismaTransactionService,
  ],
  exports: [CustomerTimelineService, CustomerRepository],
})
export class CrmModule {}
