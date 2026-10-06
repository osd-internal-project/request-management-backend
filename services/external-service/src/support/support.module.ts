import { Module } from '@nestjs/common';
import { SupportModule } from '@request-management/core-service';
import { AuthModule } from '../auth/auth.module';
import { ExternalSupportController } from './support.controller';

/**
 * `api/v1/support/*` — the three services are exported by core's Support
 * domain module. Its sweeps (on-call, PM rounds, claims) are zeroed in this
 * service's config, as they already were in anticipation.
 */
@Module({
  imports: [SupportModule, AuthModule],
  controllers: [ExternalSupportController],
})
export class SupportApiModule {}
