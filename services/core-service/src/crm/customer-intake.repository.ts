import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  type TQueryClient,
} from '@request-management/share';

/** CD-66 ช่องทางรับคำขอจากลูกค้า ต่อบริษัท. */
@Injectable()
export class RequestIntakeChannelRepository extends BaseRepository<
  PrismaService['requestIntakeChannel']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.requestIntakeChannel;
  }
}
