import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
} from '@request-management/share';

/**
 * REQ-01 — request types are configuration.
 *
 * Its own repository rather than a reach through `RequestRepository`: the A2
 * admin screen edits types without touching a single request, and the two will
 * keep diverging as that screen grows.
 */
@Injectable()
export class RequestTypeRepository extends BaseRepository<
  PrismaService['requestType']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.requestType;
  }
}
