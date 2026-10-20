import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
} from '@request-management/share';

/** G-07 — where a company's events are sent. */
@Injectable()
export class WebhookSubscriptionRepository extends BaseRepository<
  PrismaService['webhookSubscription']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.webhookSubscription;
  }

  listeningTo(companyId: string, eventName: string) {
    return this.findMany({
      where: { companyId, active: true, events: { has: eventName } },
      select: { id: true },
    });
  }
}

export interface ClaimedDelivery {
  id: string;
  subscriptionId: string;
  eventName: string;
  eventId: string;
  payload: Prisma.JsonValue;
  attempts: number;
  createdAt: Date;
}

/** G-07 — the outbox: one row per event per subscription. */
@Injectable()
export class WebhookDeliveryRepository extends BaseRepository<
  PrismaService['webhookDelivery']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.webhookDelivery;
  }

  /**
   * Take up to `limit` due rows and lease them for `leaseMs`. SKIP LOCKED so
   * two replicas never take the same row; a `sending` row whose lease ran out
   * (the process died mid-call) is due again.
   *
   * Times come from this process, not the DB's NOW(): every other time on the
   * row (default, backoff) is the app's clock, the DB session runs in
   * Asia/Bangkok (bare NOW() was 7 hours off) and its clock drifts from ours.
   */
  claimDue(
    limit: number,
    leaseMs: number,
    now = new Date(),
  ): Promise<ClaimedDelivery[]> {
    const due = now.toISOString();
    const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
    return this.prisma.$queryRaw<ClaimedDelivery[]>`
      UPDATE "webhook_deliveries"
         SET "status" = 'sending',
             "attempts" = "attempts" + 1,
             "nextAttemptAt" = (${leaseUntil}::timestamptz AT TIME ZONE 'UTC')
       WHERE "id" IN (
         SELECT "id" FROM "webhook_deliveries"
          WHERE "status" IN ('pending', 'sending')
            AND "nextAttemptAt" <= (${due}::timestamptz AT TIME ZONE 'UTC')
          ORDER BY "nextAttemptAt"
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
       )
   RETURNING "id", "subscriptionId", "eventName", "eventId", "payload",
             "attempts", "createdAt"`;
  }
}
