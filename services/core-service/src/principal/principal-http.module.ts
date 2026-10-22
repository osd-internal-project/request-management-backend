import { Module } from '@nestjs/common';
import { PrincipalModule } from './principal.module';
import { ApiKeyAdminController } from './api-key-admin.controller';
import { IntegrationAdminController } from './integration-admin.controller';

/**
 * The screen-facing routes of {@link PrincipalModule} — the admin screen that
 * issues and revokes API keys (`admin.integration.manage`).
 *
 * Separate for the reason in `src/index.ts`, and with extra force here: this
 * is the screen that *mints* the credentials external-service accepts. It
 * belongs on the internal port only.
 */
@Module({
  imports: [PrincipalModule],
  controllers: [ApiKeyAdminController, IntegrationAdminController],
})
export class PrincipalHttpModule {}
