import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  Permission,
  Principal,
  PrismaService,
  TQueryClient,
} from '@request-management/share';

/** What a module hands the timeline — everything else is derived. */
export interface TimelineEventInput {
  readonly companyId: string;
  readonly customerId: string;
  /** `customer`, `request`, `opportunity`, … + the row id (REQ-06 ref mechanism). */
  readonly refType: string;
  readonly refId?: string | null;
  readonly eventType: string;
  readonly summary: string;
  readonly actorId?: string | null;
  readonly actorName?: string | null;
  /**
   * Permission needed to see this event in the feed, or omitted for anyone
   * who can open the customer. C360-03 AC: an event whose source module the
   * viewer may not read must not appear.
   */
  readonly requiredPermission?: Permission;
  readonly occurredAt?: Date;
}

/**
 * C360-03 — the one interface modules publish customer-timeline events
 * through. Nothing writes `customer_timeline_events` directly, and this class
 * deliberately has **no update and no delete method** — append-only is
 * structural, the same way `AuditWriter` does it.
 *
 * The generic event schema (refType/refId/eventType/actor/occurredAt/summary)
 * is the spec's explicit ask, because ระยะ 4 (AI CARE conversations) lands in
 * this same feed.
 */
@Injectable()
export class CustomerTimelineService {
  constructor(private readonly prisma: PrismaService) {}

  /** Inside a transaction the write joins it — pass the tx client. */
  async publish(
    event: TimelineEventInput,
    option?: { prisma?: TQueryClient },
  ): Promise<void> {
    const client = option?.prisma ?? this.prisma;

    await client.customerTimelineEvent.create({
      data: {
        companyId: event.companyId,
        customerId: event.customerId,
        refType: event.refType,
        refId: event.refId ?? null,
        eventType: event.eventType,
        summary: event.summary,
        actorId: event.actorId ?? null,
        actorName: event.actorName ?? null,
        requiredPermission: event.requiredPermission ?? null,
        occurredAt: event.occurredAt ?? new Date(),
      },
    });
  }

  /**
   * The feed for one customer, newest first, filtered to what this viewer may
   * see: events carrying a `requiredPermission` the viewer lacks are excluded
   * in the query, not after it — a page of the feed must not shrink oddly.
   *
   * The caller has already resolved the customer through
   * `visibleCustomersWhere`; this method never re-checks it.
   */
  list(
    customerId: string,
    viewer: Principal,
    filter: { from?: Date; to?: Date; eventType?: string } = {},
  ) {
    const occurredAt: Prisma.DateTimeFilter | undefined =
      filter.from || filter.to
        ? { gte: filter.from, lte: filter.to }
        : undefined;

    return this.prisma.customerTimelineEvent.findMany({
      where: {
        customerId,
        eventType: filter.eventType,
        occurredAt,
        OR: [
          { requiredPermission: null },
          { requiredPermission: { in: [...viewer.permissions] } },
        ],
      },
      orderBy: { occurredAt: 'desc' },
      take: 200,
    });
  }
}
