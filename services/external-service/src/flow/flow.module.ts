import { Module } from '@nestjs/common';
import { CrmModule, RequestsModule } from '@request-management/core-service';
import { AuthModule } from '../auth/auth.module';
import { LegalModule } from '../legal/legal.module';
import { PmModule } from '../pm/pm.module';
import { PresalesModule } from '../presales/presales.module';
import { ExternalFlowController } from './flow.controller';
import { FlowService } from './flow.service';

/** `api/v1/flow/*` — composes the post-deal modules; owns no data. */
@Module({
  imports: [
    CrmModule,
    RequestsModule,
    PresalesModule,
    LegalModule,
    PmModule,
    AuthModule,
  ],
  controllers: [ExternalFlowController],
  providers: [FlowService],
})
export class FlowModule {}
