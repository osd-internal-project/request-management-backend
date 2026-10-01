import { Module } from '@nestjs/common';
import { PricingModule } from './pricing.module';
import { PricesController } from './prices.controller';
import { MarkupController } from './markup.controller';

/** The screen-facing routes of {@link PricingModule}. */
@Module({
  imports: [PricingModule],
  controllers: [PricesController, MarkupController],
})
export class PricingHttpModule {}
