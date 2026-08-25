import { Module } from '@nestjs/common';
import { PrismaTransactionService } from '@request-management/share';
import { KeycloakRoleMappingRepository } from './keycloak-role-mapping.repository';
import { PermissionRepository } from './permission.repository';
import { RoleRepository } from './role.repository';
import { RolesController } from './roles.controller';
import { RolesService } from './roles.service';
import { UserRoleRepository } from './user-role.repository';

@Module({
  controllers: [RolesController],
  providers: [
    RolesService,
    RoleRepository,
    UserRoleRepository,
    PermissionRepository,
    KeycloakRoleMappingRepository,
    PrismaTransactionService,
  ],
  exports: [RolesService],
})
export class RolesModule {}
