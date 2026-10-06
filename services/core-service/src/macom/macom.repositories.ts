import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
} from '@request-management/share';

/** CD-271 — one post on one channel. */
@Injectable()
export class ContentItemRepository extends BaseRepository<
  PrismaService['contentItem']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.contentItem;
  }
}

/** CD-271 — a post's media. */
@Injectable()
export class ContentFileRepository extends BaseRepository<
  PrismaService['contentFile']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.contentFile;
  }
}
