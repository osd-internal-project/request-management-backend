import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  type TQueryClient,
} from '@request-management/share';

/** CD-86 แผนบัญชีลูกค้าเดิม. */
@Injectable()
export class CustomerAccountPlanRepository extends BaseRepository<
  PrismaService['customerAccountPlan']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.customerAccountPlan;
  }
}

/** CD-86 การติดต่อ/ทบทวนลูกค้าเดิม. */
@Injectable()
export class CustomerTouchpointRepository extends BaseRepository<
  PrismaService['customerTouchpoint']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.customerTouchpoint;
  }
}

/** CD-248 — service ratings, read for the customer's health. */
@Injectable()
export class KeeperSurveyRepository extends BaseRepository<
  PrismaService['serviceSurvey']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.serviceSurvey;
  }
}
