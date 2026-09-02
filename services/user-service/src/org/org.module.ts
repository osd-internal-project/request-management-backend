import { Module } from '@nestjs/common';
import { PrismaTransactionService } from '@request-management/share';
import { PolicyModule } from '../policy/policy.module';
import { RolesModule } from '../roles/roles.module';
import { UsersModule } from '../users/users.module';
import { CompanyRepository } from './company.repository';
import { OrgClosureRepository } from './org-closure.repository';
import {
  OrgChartController,
  OrgController,
  OrgInternalController,
} from './org.controller';
import { ApprovalContextService } from './approval-context.service';
import { OrgService } from './org.service';
import { OrgUnitRepository } from './org-unit.repository';
import { UserCompanyRepository } from './user-company.repository';

@Module({
  imports: [UsersModule, RolesModule, PolicyModule],
  controllers: [OrgController, OrgChartController, OrgInternalController],
  providers: [
    OrgService,
    ApprovalContextService,
    CompanyRepository,
    OrgUnitRepository,
    OrgClosureRepository,
    UserCompanyRepository,
    PrismaTransactionService,
  ],
  exports: [
    OrgService,
    ApprovalContextService,
    CompanyRepository,
    UserCompanyRepository,
  ],
})
export class OrgModule {}
