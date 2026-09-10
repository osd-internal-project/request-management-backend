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

/** What the opportunity list and the 360° tab both select. */
export const OPPORTUNITY_LIST_SELECT = {
  id: true,
  opportunityCode: true,
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
} satisfies Prisma.OpportunitySelect;

@Injectable()
export class OpportunityRepository extends BaseRepository<PrismaService['opportunity']> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.opportunity;
  }

  /** มูลค่ารวมของโอกาสการขายตาม where — used by the 360° summary card. */
  async sumAmount(where: Prisma.OpportunityWhereInput): Promise<number> {
    const result = await this.prisma.opportunity.aggregate({
      where,
      _sum: { amount: true },
    });
    return Number(result._sum.amount ?? 0);
  }
}

@Injectable()
export class OpportunityProductRepository extends BaseRepository<
  PrismaService['opportunityProduct']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.opportunityProduct;
  }
}

@Injectable()
export class OpportunityLostReasonRepository extends BaseRepository<
  PrismaService['opportunityLostReason']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.opportunityLostReason;
  }
}
