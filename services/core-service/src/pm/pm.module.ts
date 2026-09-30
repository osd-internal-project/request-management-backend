import { Module } from '@nestjs/common';
import { PrismaTransactionService } from '@request-management/share';
import { AccessModule } from '../access/access.module';
import { CustomerContractRepository } from '../crm/contract.repositories';
import { ContractInstallmentRepository } from '../crm/contract-installments.service';
import { ContractRequestPackageRepository } from '../crm/contract-request-package.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { PresalesModule } from '../presales/presales.module';
import { RunNumberClientModule } from '../run-number/run-number-client.module';
import { ProjectsService } from './projects.service';
import {
  ProjectMemberRepository,
  ProjectRepository,
} from './project.repositories';

/**
 * CD-18 PM — projects opened from signed contracts. Reads what Legal and
 * Pre-Sales recorded (the contract, its billing schedule, the approved
 * Solution) through their repositories; writes only its own tables. The
 * domain half: its routes are in {@link PmHttpModule}.
 */
@Module({
  imports: [
    AccessModule,
    PresalesModule,
    NotificationsModule,
    RunNumberClientModule,
  ],
  providers: [
    ProjectRepository,
    ProjectMemberRepository,
    CustomerContractRepository,
    ContractInstallmentRepository,
    ContractRequestPackageRepository,
    PrismaTransactionService,
    ProjectsService,
  ],
  exports: [ProjectsService, ProjectRepository, ProjectMemberRepository],
})
export class PmModule {}
