import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { KeycloakAdminController } from './keycloak-admin.controller';
import { KeycloakAdminService } from './keycloak-admin.service';
import keycloakConfig from '../auth/keycloak.config';

@Module({
  imports: [ConfigModule.forFeature(keycloakConfig), HttpModule],
  controllers: [KeycloakAdminController],
  providers: [KeycloakAdminService],
  exports: [KeycloakAdminService],
})
export class KeycloakAdminModule {}
