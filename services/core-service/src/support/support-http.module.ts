import { Module } from '@nestjs/common';
import {
  ServiceAssetsController,
  ServiceBillingsController,
  ServiceEntitlementsController,
  ServiceLabourRatesController,
  ServicePmController,
  ServiceTimeMaterialsController,
  ServiceOnCallController,
  ServiceWorkOrdersController,
} from './support.controller';
import { SupportModule } from './support.module';

/** The screen-facing routes of {@link SupportModule}. */
@Module({
  imports: [SupportModule],
  controllers: [
    ServiceAssetsController,
    ServiceEntitlementsController,
    ServiceWorkOrdersController,
    ServiceOnCallController,
    ServiceBillingsController,
    ServiceTimeMaterialsController,
    ServiceLabourRatesController,
    ServicePmController,
  ],
})
export class SupportHttpModule {}
