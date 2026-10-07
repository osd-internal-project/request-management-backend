import { Module } from '@nestjs/common';
import { PrismaTransactionService } from '@request-management/share';
import {
  CompanyMemberRepository,
  ContractAccessRepository,
  ContractDocumentRepository,
  CrmModule,
  CustomerContractRepository,
  LegalContractsService,
} from '@request-management/core-service';
import { AuthModule } from '../auth/auth.module';
import { NoFileStorage } from '../common/no-file-storage';
import { ExternalContractsController } from './contracts.controller';

/**
 * `api/v1/legal/*` — the contract repository, read from outside.
 *
 * `LegalContractsService` lives in core's `CrmHttpModule`, beside the storage
 * its uploads need, so it is declared again here with the repositories it
 * takes there. Terms, installments and obligations are already exported by
 * the CRM domain module.
 */
@Module({
  imports: [CrmModule, AuthModule],
  controllers: [ExternalContractsController],
  providers: [
    LegalContractsService,
    CustomerContractRepository,
    ContractDocumentRepository,
    ContractAccessRepository,
    CompanyMemberRepository,
    PrismaTransactionService,
    NoFileStorage,
  ],
  exports: [LegalContractsService],
})
export class LegalModule {}
