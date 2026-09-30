import { Module } from '@nestjs/common';
import { PricingModule } from './pricing.module';
import { PricesController } from './prices.controller';
import { PricesService } from './prices.service';

/** The screen-facing routes of {@link PricingModule}. */
@Module({
  imports: [PricingModule],
  controllers: [PricesController],
  providers: [PricesService],
})
export class PricingHttpModule {}
