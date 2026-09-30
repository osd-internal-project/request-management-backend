import { Module } from '@nestjs/common';
import { PrismaTransactionService } from '@request-management/share';
import { CrmModule } from '../crm/crm.module';
import { ProductRepository } from '../crm/product.repositories';
import { ProductPriceRepository } from './pricing.repositories';

/** CD-12 Pricing — the domain half (see `src/index.ts` for the split). */
@Module({
  imports: [CrmModule],
  providers: [
    ProductPriceRepository,
    ProductRepository,
    PrismaTransactionService,
  ],
  exports: [
    CrmModule,
    ProductPriceRepository,
    ProductRepository,
    PrismaTransactionService,
  ],
})
export class PricingModule {}
