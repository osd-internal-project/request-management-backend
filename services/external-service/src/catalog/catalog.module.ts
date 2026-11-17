import { Module } from '@nestjs/common';
import { CrmModule as CoreCrmModule } from '@request-management/core-service';
import { AuthModule } from '../auth/auth.module';
import { ExternalProductsController } from './products.controller';

/** `api/v1/products` — the product catalog, read from outside. */
@Module({
  imports: [CoreCrmModule, AuthModule],
  controllers: [ExternalProductsController],
})
export class CatalogModule {}
