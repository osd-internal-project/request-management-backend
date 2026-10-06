import { Module } from '@nestjs/common';
import { CareModule } from '@request-management/core-service';
import { AuthModule } from '../auth/auth.module';
import { CareApiController } from './care.controller';

/** `api/v1/care/*` — CD-280, channels and AI CARE posting conversations. */
@Module({
  imports: [CareModule, AuthModule],
  controllers: [CareApiController],
})
export class CareApiModule {}
