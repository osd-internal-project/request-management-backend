import { Module } from '@nestjs/common';
import { PrismaTransactionService } from '@request-management/share';
import { UserCompanyRepository } from '../org/user-company.repository';
import { RoleRepository } from '../roles/role.repository';
import { RolesModule } from '../roles/roles.module';
import { SystemController } from './system.controller';
import { SystemRepository } from './system.repository';
import { SystemService } from './system.service';

@Module({
  imports: [RolesModule],
  controllers: [SystemController],
  providers: [
    SystemService,
    SystemRepository,
    RoleRepository,
    UserCompanyRepository,
    PrismaTransactionService,
  ],
})
export class SystemModule {}
