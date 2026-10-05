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

/** CD-239 — the service side of a case. */
@Injectable()
export class ServiceWorkOrderRepository extends BaseRepository<
  PrismaService['serviceWorkOrder']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.serviceWorkOrder;
  }
}

/** CD-241 — the out-of-hours rota. */
@Injectable()
export class ServiceOnCallShiftRepository extends BaseRepository<
  PrismaService['serviceOnCallShift']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.serviceOnCallShift;
  }
}

/** CD-241 — cases sent to the rota. */
@Injectable()
export class ServiceOnCallDispatchRepository extends BaseRepository<
  PrismaService['serviceOnCallDispatch']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.serviceOnCallDispatch;
  }
}

/** CD-241 — the company's working calendar, to tell out of hours. */
@Injectable()
export class ServiceCalendarRepository extends BaseRepository<
  PrismaService['holidayCalendar']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.holidayCalendar;
  }
}

/** CD-242 — billed service jobs' charges. */
@Injectable()
export class ServiceBillingRepository extends BaseRepository<
  PrismaService['serviceBilling']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.serviceBilling;
  }
}
