import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
} from '@request-management/share';

/** CM-06 — the sync queue's rows. Domain rules live in the sync service. */
@Injectable()
export class IntegrationSyncJobRepository extends BaseRepository<
  PrismaService['integrationSyncJob']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.integrationSyncJob;
  }
}
