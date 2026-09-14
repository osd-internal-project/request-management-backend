import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { Agent as HttpsAgent } from 'node:https';
import { KeycloakAdminController } from './keycloak-admin.controller';
import { KeycloakAdminService } from './keycloak-admin.service';
import keycloakConfig from '../auth/keycloak.config';

/**
 * Same KEYCLOAK_TLS_INSECURE escape hatch as AuthModule — this module's
 * HttpModule import creates its OWN HttpService instance, entirely separate
 * from AuthModule's, so that fix did not cover it. Every call this service
 * makes to the Keycloak Admin API (GET/PUT/DELETE /admin/realms/...) failed
 * against the same self-signed cert until this was added — discovered via
 * the Users admin screen answering "ไม่สามารถติดต่อ Keycloak Admin API ได้".
 */
const keycloakInsecureTls = process.env.KEYCLOAK_TLS_INSECURE === 'true';

@Module({
  imports: [
    ConfigModule.forFeature(keycloakConfig),
    HttpModule.register(
      keycloakInsecureTls
        ? { httpsAgent: new HttpsAgent({ rejectUnauthorized: false }) }
        : {},
    ),
  ],
  controllers: [KeycloakAdminController],
  providers: [KeycloakAdminService],
  exports: [KeycloakAdminService],
})
export class KeycloakAdminModule {}
