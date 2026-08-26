import { Module } from '@nestjs/common';
import { KeycloakAdminModule } from '../keycloak-admin/keycloak-admin.module';
import { UsersController } from './users.controller';
import { UsersRepository } from './users.repository';
import { UsersService } from './users.service';

@Module({
  imports: [KeycloakAdminModule],
  controllers: [UsersController],
  providers: [UsersService, UsersRepository],
  exports: [UsersService, UsersRepository],
})
export class UsersModule {}
