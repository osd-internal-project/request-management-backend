import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
} from '@request-management/share';

/**
 * CM-07 — segmentation is configuration (dimensions and values are rows an
 * admin edits, never code), so these repositories serve both the admin screen
 * and the assignment writes on a customer.
 */

@Injectable()
export class CustomerSegmentDimensionRepository extends BaseRepository<
  PrismaService['customerSegmentDimension']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.customerSegmentDimension;
  }
}

@Injectable()
export class CustomerSegmentValueRepository extends BaseRepository<
  PrismaService['customerSegmentValue']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.customerSegmentValue;
  }
}

@Injectable()
export class CustomerSegmentAssignmentRepository extends BaseRepository<
  PrismaService['customerSegmentAssignment']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.customerSegmentAssignment;
  }
}

@Injectable()
export class CrmConfigRepository extends BaseRepository<
  PrismaService['crmCompanyConfig']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.crmCompanyConfig;
  }
}
