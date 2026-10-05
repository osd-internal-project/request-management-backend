import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StorageModule, type StorageOptions } from '@request-management/share';
import { ContractTermsRepository } from '../crm/contract-terms.service';
import { CustomerContractRepository } from '../crm/contract.repositories';
import { CustomerRepository } from '../crm/customer.repository';
import { CompanyRepository } from '../crm/product.repositories';
import { CrmConfigRepository } from '../crm/segment.repositories';
import { RequestRepository } from '../requests/request.repository';
import { ServiceReportsService } from './service-reports.service';
import {
  ServiceEntitlementRepository,
  ServicePmRoundRepository,
  ServiceReportRepository,
  ServiceSlaClockRepository,
  ServiceWorkOrderRepository,
} from './support.repositories';
import {
  ServiceAssetsController,
  ServiceBillingsController,
  ServiceClaimsController,
  ServiceProblemsController,
  ServiceReportsController,
  ServiceSurveysController,
  ServiceSurveysPublicController,
  ServiceEntitlementsController,
  ServiceLabourRatesController,
  ServicePmController,
  ServiceTimeMaterialsController,
  ServiceOnCallController,
  ServiceWorkOrdersController,
} from './support.controller';
import { SupportModule } from './support.module';

/** The screen-facing routes of {@link SupportModule}. */
@Module({
  imports: [
    SupportModule,
    // CD-247 — the report PDFs; storage for the HTTP half only
    StorageModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        config.get<StorageOptions>('storage'),
    }),
  ],
  providers: [
    ServiceReportsService,
    ServiceReportRepository,
    ServiceSlaClockRepository,
    ServiceEntitlementRepository,
    ServiceWorkOrderRepository,
    ServicePmRoundRepository,
    RequestRepository,
    CustomerRepository,
    CustomerContractRepository,
    ContractTermsRepository,
    CompanyRepository,
    CrmConfigRepository,
  ],
  controllers: [
    ServiceAssetsController,
    ServiceEntitlementsController,
    ServiceWorkOrdersController,
    ServiceOnCallController,
    ServiceBillingsController,
    ServiceTimeMaterialsController,
    ServiceLabourRatesController,
    ServicePmController,
    ServiceClaimsController,
    ServiceProblemsController,
    ServiceReportsController,
    ServiceSurveysController,
    ServiceSurveysPublicController,
  ],
})
export class SupportHttpModule {}
