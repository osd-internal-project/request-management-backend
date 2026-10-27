import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
} from '@request-management/share';

/** One background job handed to an external agent. */
@Injectable()
export class AgentRecordRepository extends BaseRepository<
  PrismaService['agentRecord']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.agentRecord;
  }
}
