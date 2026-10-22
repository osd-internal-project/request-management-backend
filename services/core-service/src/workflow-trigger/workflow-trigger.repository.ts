import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
} from '@request-management/share';

/** Which workflow each CTD event of a company starts. */
@Injectable()
export class WorkflowTriggerRepository extends BaseRepository<
  PrismaService['workflowTrigger']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.workflowTrigger;
  }

  listeningTo(companyId: string, eventKey: string) {
    return this.findMany({
      where: { companyId, eventKey, active: true },
      select: { id: true, typeCodes: true },
    }) as Promise<{ id: string; typeCodes: string[] }[]>;
  }
}

export interface ClaimedStart {
  id: string;
  triggerId: string;
  companyId: string;
  eventKey: string;
  resourceType: string;
  resourceId: string;
  variables: Prisma.JsonValue;
  attempts: number;
}

/** The outbox and history: one row per trigger per document. */
@Injectable()
export class WorkflowStartRepository extends BaseRepository<
  PrismaService['workflowStart']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.workflowStart;
  }

  /**
   * Take up to `limit` due rows and lease them for `leaseMs` — the webhook
   * outbox's claim (SKIP LOCKED, app clock; see `WebhookDeliveryRepository`).
   */
  claimDue(
    limit: number,
    leaseMs: number,
    now = new Date(),
  ): Promise<ClaimedStart[]> {
    const due = now.toISOString();
    const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
    return this.prisma.$queryRaw<ClaimedStart[]>`
      UPDATE "workflow_starts"
         SET "status" = 'sending',
             "attempts" = "attempts" + 1,
             "nextAttemptAt" = (${leaseUntil}::timestamptz AT TIME ZONE 'UTC')
       WHERE "id" IN (
         SELECT "id" FROM "workflow_starts"
          WHERE "status" IN ('pending', 'sending')
            AND "nextAttemptAt" <= (${due}::timestamptz AT TIME ZONE 'UTC')
          ORDER BY "nextAttemptAt"
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
       )
   RETURNING "id", "triggerId", "companyId", "eventKey", "resourceType",
             "resourceId", "variables", "attempts"`;
  }
}
