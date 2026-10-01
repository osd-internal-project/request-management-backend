import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
} from '@request-management/share';

export { ProductPriceRepository } from '../crm/product.repositories';

/** CD-195 ประวัติการบันทึกราคา — append-only. */
@Injectable()
export class ProductPriceVersionRepository extends BaseRepository<
  PrismaService['productPriceVersion']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.productPriceVersion;
  }
}

/** CD-200 กฎ markup. */
@Injectable()
export class MarkupRuleRepository extends BaseRepository<
  PrismaService['markupRule']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.markupRule;
  }
}
