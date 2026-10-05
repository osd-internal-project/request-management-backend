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

/** CD-243 — selling rates per work type. */
@Injectable()
export class ServiceLabourRateRepository extends BaseRepository<
  PrismaService['serviceLabourRate']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.serviceLabourRate;
  }
}

/** CD-243 — materials used on service jobs. */
@Injectable()
export class ServiceMaterialUseRepository extends BaseRepository<
  PrismaService['serviceMaterialUse']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.serviceMaterialUse;
  }
}

/** CD-243 — HR work types (CD-207), to name the selling rates. */
@Injectable()
export class ServiceWorkTypeRepository extends BaseRepository<
  PrismaService['hrWorkType']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.hrWorkType;
  }
}

/** CD-244 — PM plans. */
@Injectable()
export class ServicePmPlanRepository extends BaseRepository<
  PrismaService['servicePmPlan']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.servicePmPlan;
  }
}

/** CD-244 — PM rounds. */
@Injectable()
export class ServicePmRoundRepository extends BaseRepository<
  PrismaService['servicePmRound']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.servicePmRound;
  }
}

/** CD-244 — service-contract offers for covers with no contract. */
@Injectable()
export class ServiceMaOfferRepository extends BaseRepository<
  PrismaService['serviceMaOffer']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.serviceMaOffer;
  }
}

/** CD-245 — claims to suppliers. */
@Injectable()
export class ServiceClaimRepository extends BaseRepository<
  PrismaService['serviceClaim']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.serviceClaim;
  }
}

/** CD-246 — problems behind repeated faults. */
@Injectable()
export class ServiceProblemRepository extends BaseRepository<
  PrismaService['serviceProblem']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.serviceProblem;
  }
}

/** CD-246 — jobs under a problem. */
@Injectable()
export class ServiceProblemLinkRepository extends BaseRepository<
  PrismaService['serviceProblemLink']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.serviceProblemLink;
  }
}

/** CD-246 — suggested groups set aside. */
@Injectable()
export class ServiceProblemDismissalRepository extends BaseRepository<
  PrismaService['serviceProblemDismissal']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.serviceProblemDismissal;
  }
}

/** CD-247 — issued service reports. */
@Injectable()
export class ServiceReportRepository extends BaseRepository<
  PrismaService['serviceReport']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.serviceReport;
  }
}

/** CD-247 — the cases' SLA clocks, read for the report. */
@Injectable()
export class ServiceSlaClockRepository extends BaseRepository<
  PrismaService['slaClock']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.slaClock;
  }
}

/** CD-248 — satisfaction surveys after service jobs. */
@Injectable()
export class ServiceSurveyRepository extends BaseRepository<
  PrismaService['serviceSurvey']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.serviceSurvey;
  }
}

/** CD-249 — people at customers invited to the portal. */
@Injectable()
export class ServicePortalContactRepository extends BaseRepository<
  PrismaService['servicePortalContact']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.servicePortalContact;
  }
}

/** CD-249 — portal sessions. */
@Injectable()
export class ServicePortalSessionRepository extends BaseRepository<
  PrismaService['servicePortalSession']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.servicePortalSession;
  }
}
