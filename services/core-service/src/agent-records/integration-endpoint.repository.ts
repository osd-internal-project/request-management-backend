import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
} from '@request-management/share';

/** Where CTD sends each agent job of a company — one endpoint per action. */
@Injectable()
export class IntegrationEndpointRepository extends BaseRepository<
  PrismaService['integrationEndpoint']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.integrationEndpoint;
  }
}
