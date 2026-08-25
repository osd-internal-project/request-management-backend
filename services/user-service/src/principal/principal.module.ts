import { Module } from '@nestjs/common';
import { OrgModule } from '../org/org.module';
import { PolicyModule } from '../policy/policy.module';
import { RolesModule } from '../roles/roles.module';
import { UsersModule } from '../users/users.module';
import { PrincipalGuard } from './principal.guard';
import { PrincipalService } from './principal.service';

@Module({
  imports: [UsersModule, OrgModule, RolesModule, PolicyModule],
  providers: [PrincipalService, PrincipalGuard],
  exports: [PrincipalService, PrincipalGuard],
})
export class PrincipalModule {}
