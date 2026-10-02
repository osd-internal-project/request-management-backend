import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
} from '@request-management/share';

/** CD-207 — HR's levels, work types and labour cost rates. */

@Injectable()
export class HrLevelRepository extends BaseRepository<
  PrismaService['hrLevel']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.hrLevel;
  }
}

@Injectable()
export class HrWorkTypeRepository extends BaseRepository<
  PrismaService['hrWorkType']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.hrWorkType;
  }
}

@Injectable()
export class HrLaborRateRepository extends BaseRepository<
  PrismaService['hrLaborRate']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.hrLaborRate;
  }
}
