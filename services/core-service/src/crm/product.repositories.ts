import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
  TxOption,
} from '@request-management/share';

/** CD-27 — the product catalog copied from SAP. Rules live in the service. */
@Injectable()
export class ProductRepository extends BaseRepository<
  PrismaService['product']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.product;
  }
}

/**
 * Companies, read-only — the catalog sync walks every active company, each
 * its own CompanyDB in SAP. Identity and org stay user-service's.
 */
@Injectable()
export class CompanyRepository extends BaseRepository<
  PrismaService['company']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.company;
  }
}

/**
 * CD-194 ราคาขายมาตรฐาน — lives with the catalog so a quotation (CD-195) can
 * check the price its line came from without CRM depending on Pricing.
 */
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
