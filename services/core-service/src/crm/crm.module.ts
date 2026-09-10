import { Module } from '@nestjs/common';
import { PrismaTransactionService } from '@request-management/share';
import { AccessModule } from '../access/access.module';
import { RequestsModule } from '../requests/requests.module';
import { OdooModule } from '../odoo/odoo.module';
import { PdpaModule } from '../pdpa/pdpa.module';
import { EventsModule } from '../events/events.module';
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
import { CustomerImportService } from './customer-import.service';
import { CustomerOdooSyncService } from './customer-odoo-sync.service';
import { IntegrationSyncJobRepository } from './integration-job.repository';
import { KycProductRuleRepository } from './kyc-product.repository';
import { KycCallbackService } from './kyc-callback.service';
import {
  DealLostReasonRepository,
  DealProductRepository,
  DealRepository,
  LeadRepository,
} from './sales.repositories';
import { DealCodeService } from './deal-code.service';
import { LeadsService } from './leads.service';
import { DealsService } from './deals.service';
import { DealsController, LeadsController } from './sales.controllers';
import { LeadImportService } from './lead-import.service';

/**
 * CRM ระยะ 1 — Customer Master (CD-59 / CM-01…09) + the parts of มุมมอง 360°
 * that live on the customer itself (CD-68 / C360-03 timeline).
 *
 * `CustomerTimelineService` is exported: it is the one interface other
 * modules (requests today; deals, cases later) publish customer-timeline
 * events through — nothing writes the table directly (C360-03).
 */
@Module({
  imports: [AccessModule, RequestsModule, OdooModule, PdpaModule, EventsModule],
  controllers: [CustomersController, CrmAdminController, LeadsController, DealsController],
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
    CustomerImportService,
    CustomerOdooSyncService,
    IntegrationSyncJobRepository,
    KycProductRuleRepository,
    KycCallbackService,
    LeadRepository,
    DealRepository,
    DealProductRepository,
    DealLostReasonRepository,
    DealCodeService,
    LeadsService,
    LeadImportService,
    DealsService,
    PrismaTransactionService,
  ],
  exports: [CustomerTimelineService, CustomerRepository],
})
export class CrmModule {}
