import { Module } from '@nestjs/common';
import { CustomerContractRepository } from '../crm/contract.repositories';
import {
  LeadRepository,
  OpportunityRepository,
  QuotationRepository,
  SaleOrderRepository,
} from '../crm/sales.repositories';
import { CrmConfigRepository } from '../crm/segment.repositories';
import { AcceptanceCertificateRepository } from '../delivery/delivery.repositories';
import { ProjectRepository } from '../pm/project.repositories';
import { SolutionRepository } from '../presales/solution.repositories';
import { RequestRepository } from '../requests/request.repository';
import { ProcessFlowLogRepository } from './process-log.repository';
import { ProcessLogService } from './process-log.service';
import { ProcessRefsService } from './process-refs.service';

/** End-to-End process log — domain half, shared by core and external. */
@Module({
  providers: [
    ProcessFlowLogRepository,
    ProcessLogService,
    // read-only, for the deal's document numbers (ProcessRefsService)
    LeadRepository,
    OpportunityRepository,
    QuotationRepository,
    SaleOrderRepository,
    CustomerContractRepository,
    CrmConfigRepository,
    SolutionRepository,
    RequestRepository,
    ProjectRepository,
    AcceptanceCertificateRepository,
    ProcessRefsService,
  ],
  exports: [ProcessLogService, ProcessRefsService],
})
export class ProcessLogModule {}
