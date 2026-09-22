import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
} from '@request-management/share';

@Injectable()
export class RunNumberSettingRepository extends BaseRepository<
  PrismaService['runNumberSetting']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.runNumberSetting;
  }
}

@Injectable()
export class RunNumberCounterRepository extends BaseRepository<
  PrismaService['runNumberCounter']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.runNumberCounter;
  }
}
