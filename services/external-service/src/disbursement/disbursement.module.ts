import { Module } from '@nestjs/common';
import { DisbursementModule as CoreDisbursementModule } from '@request-management/core-service';
import { AuthModule } from '../auth/auth.module';
import { ExternalDisbursementsController } from './disbursement.controller';

/** การเบิก on the external port: core's domain half, this service's controllers. */
@Module({
  imports: [CoreDisbursementModule, AuthModule],
  controllers: [ExternalDisbursementsController],
})
export class DisbursementModule {}
