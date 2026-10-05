import { Module } from '@nestjs/common';
import { DeliveryModule } from './delivery.module';
import { DeliveryController } from './delivery.controller';

/** The screen-facing routes of {@link DeliveryModule}. */
@Module({
  imports: [DeliveryModule],
  controllers: [DeliveryController],
})
export class DeliveryHttpModule {}
