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

/** CD-273 — a file in the brand library. */
@Injectable()
export class BrandAssetRepository extends BaseRepository<
  PrismaService['brandAsset']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.brandAsset;
  }
}

/** CD-273 — one version of a brand file. */
@Injectable()
export class BrandAssetVersionRepository extends BaseRepository<
  PrismaService['brandAssetVersion']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.brandAssetVersion;
  }
}
