import { Module } from '@nestjs/common';
import { PricingModule } from './pricing.module';
import { PricesController } from './prices.controller';
import { MarkupController } from './markup.controller';
import { PricingAnalyticsController } from './pricing-analytics.controller';
import { ProductBundlesController } from './product-bundles.controller';

/** The screen-facing routes of {@link PricingModule}. */
@Module({
  imports: [PricingModule],
  controllers: [
    PricesController,
    MarkupController,
    PricingAnalyticsController,
    ProductBundlesController,
  ],
})
export class PricingHttpModule {}
