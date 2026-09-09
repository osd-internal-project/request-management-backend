import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
} from '@request-management/share';

/** CRM sales objects — thin repositories, rules live in the services. */

@Injectable()
export class LeadRepository extends BaseRepository<PrismaService['lead']> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.lead;
  }
}

/** What the deal list and the 360° tab both select. */
export const DEAL_LIST_SELECT = {
  id: true,
  dealCode: true,
  title: true,
  stage: true,
  amount: true,
  currency: true,
  probability: true,
  expectedCloseAt: true,
  customerId: true,
  customer: { select: { id: true, customerCode: true, nameTh: true } },
  ownerUserId: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.DealSelect;

@Injectable()
export class DealRepository extends BaseRepository<PrismaService['deal']> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.deal;
  }

  /** มูลค่ารวมของดีลตาม where — used by the 360° summary card. */
  async sumAmount(where: Prisma.DealWhereInput): Promise<number> {
    const result = await this.prisma.deal.aggregate({
      where,
      _sum: { amount: true },
    });
    return Number(result._sum.amount ?? 0);
  }
}

@Injectable()
export class DealProductRepository extends BaseRepository<
  PrismaService['dealProduct']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.dealProduct;
  }
}

@Injectable()
export class DealLostReasonRepository extends BaseRepository<
  PrismaService['dealLostReason']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.dealLostReason;
  }
}
