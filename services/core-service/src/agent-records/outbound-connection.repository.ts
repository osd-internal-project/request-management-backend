import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
} from '@request-management/share';

/** A company's link to one vendor: URL, sealed key, and each action's endpoint. */
@Injectable()
export class OutboundConnectionRepository extends BaseRepository<
  PrismaService['outboundConnection']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.outboundConnection;
  }
}
