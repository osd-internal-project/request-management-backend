import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
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
