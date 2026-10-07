import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
} from '@request-management/share';

/** Company documents uploaded in settings. */
@Injectable()
export class CompanyDocumentRepository extends BaseRepository<
  PrismaService['companyDocument']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.companyDocument;
  }
}
