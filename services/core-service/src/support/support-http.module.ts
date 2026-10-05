import { Module } from '@nestjs/common';
import {
  ServiceAssetsController,
  ServiceBillingsController,
  ServiceEntitlementsController,
  ServiceLabourRatesController,
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
  ],
})
export class SupportHttpModule {}
