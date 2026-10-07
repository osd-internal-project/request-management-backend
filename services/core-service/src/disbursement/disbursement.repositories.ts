import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  type TQueryClient,
} from '@request-management/share';

/** การเบิก — Which request type raises which kind, per company. */
@Injectable()
export class DisbursementSettingsRepository extends BaseRepository<
  PrismaService['disbursementSettings']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.disbursementSettings;
  }
}

/** การเบิก — The disbursement header, one per request. */
@Injectable()
export class DisbursementRepository extends BaseRepository<
  PrismaService['disbursement']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.disbursement;
  }
}

/** การเบิก — Estimate and actual lines. */
@Injectable()
export class DisbursementLineRepository extends BaseRepository<
  PrismaService['disbursementLine']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.disbursementLine;
  }
}

/** การเบิก — The append-only money ledger. */
@Injectable()
export class DisbursementMovementRepository extends BaseRepository<
  PrismaService['disbursementMovement']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.disbursementMovement;
  }
}

/** การเบิก — Imprest funds. */
@Injectable()
export class PettyCashFundRepository extends BaseRepository<
  PrismaService['pettyCashFund']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.pettyCashFund;
  }
}

/** การเบิก — Fund top-ups. */
@Injectable()
export class PettyCashReplenishmentRepository extends BaseRepository<
  PrismaService['pettyCashReplenishment']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.pettyCashReplenishment;
  }
}
/** การเบิก — Evidence files (slips, receipts, refund proof). */
@Injectable()
export class DisbursementFileRepository extends BaseRepository<
  PrismaService['disbursementFile']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.disbursementFile;
  }
}
