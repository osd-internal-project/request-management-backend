import { Module } from '@nestjs/common';
import { PrismaTransactionService } from '@request-management/share';
import { CrmModule } from '../crm/crm.module';
import { ProductRepository } from '../crm/product.repositories';
import { CustomerRepository } from '../crm/customer.repository';
import { OpportunityRepository } from '../crm/sales.repositories';
import {
  CustomerSegmentAssignmentRepository,
  CustomerSegmentValueRepository,
} from '../crm/segment.repositories';
import {
  ProductPriceRepository,
  ProductPriceVersionRepository,
} from './pricing.repositories';

/** CD-12 Pricing — the domain half (see `src/index.ts` for the split). */
@Module({
  imports: [CrmModule],
  providers: [
    ProductPriceRepository,
    ProductPriceVersionRepository,
    ProductRepository,
    // CD-197 — who a special price is for
    CustomerRepository,
    OpportunityRepository,
    CustomerSegmentValueRepository,
    CustomerSegmentAssignmentRepository,
    PrismaTransactionService,
  ],
  exports: [
    CrmModule,
    ProductPriceRepository,
    ProductPriceVersionRepository,
    CustomerRepository,
    OpportunityRepository,
    CustomerSegmentValueRepository,
    CustomerSegmentAssignmentRepository,
    ProductRepository,
    PrismaTransactionService,
  ],
})
export class PricingModule {}
