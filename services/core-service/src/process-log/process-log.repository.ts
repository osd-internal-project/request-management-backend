import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
} from '@request-management/share';

/** Append-only: nothing here updates or deletes a row. */
@Injectable()
export class ProcessFlowLogRepository extends BaseRepository<
  PrismaService['processFlowLog']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.processFlowLog;
  }
}
