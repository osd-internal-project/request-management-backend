import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
} from '@request-management/share';

/** CD-291 — people who refused contact. */
@Injectable()
export class DoNotContactRepository extends BaseRepository<
  PrismaService['doNotContact']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.doNotContact;
  }
}
