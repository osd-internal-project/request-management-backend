import { Module } from '@nestjs/common';
import { PricingModule } from './pricing.module';
import { PricesController } from './prices.controller';

/** The screen-facing routes of {@link PricingModule}. */
@Module({
  imports: [PricingModule],
  controllers: [PricesController],
})
export class PricingHttpModule {}
