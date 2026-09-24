import { Module } from '@nestjs/common';
import { CrmModule } from '../crm/crm.module';
import { ProductsController } from './products.controller';

/** CD-27 — the screen-facing product catalog route (internal port only). */
@Module({
  imports: [CrmModule],
  controllers: [ProductsController],
})
export class ProductsHttpModule {}
