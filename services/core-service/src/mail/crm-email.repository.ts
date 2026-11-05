import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
} from '@request-management/share';

/** Nothing here deletes a row: a sent email stays, failed ones too. */
@Injectable()
export class CrmEmailRepository extends BaseRepository<
  PrismaService['crmEmail']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.crmEmail;
  }
}
