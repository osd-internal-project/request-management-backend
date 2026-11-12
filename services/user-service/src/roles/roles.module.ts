import { Module } from '@nestjs/common';
import { KeycloakAdminModule } from '../keycloak-admin/keycloak-admin.module';
import { UserCompanyRepository } from '../org/user-company.repository';
import { PrismaTransactionService } from '@request-management/share';
import { KeycloakRoleMappingRepository } from './keycloak-role-mapping.repository';
import { PermissionRepository } from './permission.repository';
import { PermissionOverrideRepository } from './permission-override.repository';
import { RoleRepository } from './role.repository';
import { RolesController } from './roles.controller';
import { RolesService } from './roles.service';
import { UserRoleRepository } from './user-role.repository';

@Module({
  imports: [KeycloakAdminModule],
  controllers: [RolesController],
  providers: [
    RolesService,
    RoleRepository,
    UserRoleRepository,
    PermissionRepository,
    PermissionOverrideRepository,
    KeycloakRoleMappingRepository,
    PrismaTransactionService,
    UserCompanyRepository,
  ],
  exports: [RolesService],
})
export class RolesModule {}
