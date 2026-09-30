import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
  TxOption,
} from '@request-management/share';

/** CD-194 ราคาขายมาตรฐาน. */
@Injectable()
export class ProductPriceRepository extends BaseRepository<
  PrismaService['productPrice']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.productPrice;
  }

  /**
   * Serialises saves of one product code + currency until the transaction
   * ends, so two people saving at once cannot both pass the overlap check.
   */
  async lockSeries(key: string, option: TxOption): Promise<void> {
    await (option.prisma ?? this.prisma)
      .$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`ctd.price.${key}`}))::text AS locked`;
  }
}
