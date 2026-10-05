import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  type TQueryClient,
} from '@request-management/share';

/** CD-236 — the installed base. */
@Injectable()
export class ServiceAssetRepository extends BaseRepository<
  PrismaService['serviceAsset']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.serviceAsset;
  }
}

/** CD-236 — what changed on an asset, and why. */
@Injectable()
export class ServiceAssetHistoryRepository extends BaseRepository<
  PrismaService['serviceAssetHistory']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.serviceAssetHistory;
  }
}

/** CD-237 — what covers the assets. */
@Injectable()
export class ServiceEntitlementRepository extends BaseRepository<
  PrismaService['serviceEntitlement']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.serviceEntitlement;
  }
}

/** CD-237 — which assets an entitlement covers. */
@Injectable()
export class ServiceEntitlementAssetRepository extends BaseRepository<
  PrismaService['serviceEntitlementAsset']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.serviceEntitlementAsset;
  }
}
