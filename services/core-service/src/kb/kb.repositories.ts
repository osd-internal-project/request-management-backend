import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  type TQueryClient,
} from '@request-management/share';

/**
 * CD-263 — knowledge articles, for services written after AGENTS.md's
 * repository rule was pointed out (the earlier KB services still read
 * through PrismaService and move here separately).
 */
@Injectable()
export class KbArticleRepository extends BaseRepository<
  PrismaService['kbArticle']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.kbArticle;
  }
}
