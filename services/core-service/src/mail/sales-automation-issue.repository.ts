import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
} from '@request-management/share';

/** Nothing deletes a row: a fixed problem gets `resolvedAt`. */
@Injectable()
export class SalesAutomationIssueRepository extends BaseRepository<
  PrismaService['salesAutomationIssue']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.salesAutomationIssue;
  }
}
