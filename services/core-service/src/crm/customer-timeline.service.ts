import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  accessSubject,
  hasPermission,
  Permission,
  Principal,
  PrismaService,
  salesAccessSubject,
  TQueryClient,
  visibleRequestsWhere,
  visibleSalesWhere,
} from '@request-management/share';

/**
 * C360-03 AC — an event whose source the viewer cannot read stays out of the
 * feed. Seeing the customer is not enough: the event describes a row in
 * another module, and that module's permission *and* its row scope decide.
 *
 * Decided here at read time from `refType`, so events written before this
 * rule existed are covered too and no publisher can forget to ask for it.
 * `requiredPermission` stays as an extra, per-event gate.
 */
type SourceRule = {
  permission: Permission;
  /** The ids among `ids` this viewer may read in the source module. */
  visibleIds: (
    prisma: PrismaService,
    viewer: Principal,
    ids: string[],
  ) => Promise<{ id: string }[]>;
};

const salesRows =
  (
    model: 'opportunity' | 'quotation' | 'saleOrder',
  ): SourceRule['visibleIds'] =>
  (prisma, viewer, ids) =>
    (
      prisma[model] as unknown as {
        findMany(args: unknown): Promise<{ id: string }[]>;
      }
    ).findMany({
      where: {
        id: { in: ids },
        AND: [visibleSalesWhere(salesAccessSubject(viewer))],
      },
      select: { id: true },
    });

const SOURCE_RULES: Readonly<Record<string, SourceRule>> = {
  opportunity: {
    permission: 'crm.sales.read',
    visibleIds: salesRows('opportunity'),
  },
  quotation: {
    permission: 'crm.sales.read',
    visibleIds: salesRows('quotation'),
  },
  sale_order: {
    permission: 'crm.sales.read',
    visibleIds: salesRows('saleOrder'),
  },
  request: {
    permission: 'request.read',
    visibleIds: (prisma, viewer, ids) =>
      prisma.request.findMany({
        where: {
          id: { in: ids },
          AND: [visibleRequestsWhere(accessSubject(viewer))],
        },
        select: { id: true },
      }),
  },
};

const GUARDED_REF_TYPES = Object.keys(SOURCE_RULES);

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
   * Whether this exact event is already on the feed — for subscribers of
   * redeliverable domain events (§11.8), which must stay idempotent without a
   * second table. Read-only; the feed stays append-only.
   */
  async has(event: {
    customerId: string;
    refType: string;
    refId: string;
    eventType: string;
  }): Promise<boolean> {
    const found = await this.prisma.customerTimelineEvent.findFirst({
      where: event,
      select: { id: true },
    });
    return found !== null;
  }

  /**
   * The feed for one customer, newest first, filtered to what this viewer may
   * see — in the query, not after it, so a page of the feed never shrinks
   * oddly:
   *   - events from another module (`SOURCE_RULES`) only when the viewer holds
   *     that module's permission and the source row is inside their scope;
   *   - events carrying a `requiredPermission` the viewer lacks, never.
   *
   * The caller has already resolved the customer through
   * `visibleCustomersWhere`; this method never re-checks it.
   */
  async list(
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
        AND: [
          {
            OR: [
              { requiredPermission: null },
              { requiredPermission: { in: [...viewer.permissions] } },
            ],
          },
          { OR: await this.visibleSources(customerId, viewer) },
        ],
      },
      orderBy: { occurredAt: 'desc' },
      take: 200,
    });
  }

  /** One branch per source type the viewer may see, restricted to its rows. */
  private async visibleSources(
    customerId: string,
    viewer: Principal,
  ): Promise<Prisma.CustomerTimelineEventWhereInput[]> {
    const branches: Prisma.CustomerTimelineEventWhereInput[] = [
      { refType: { notIn: GUARDED_REF_TYPES } },
    ];

    const readable = GUARDED_REF_TYPES.filter((refType) =>
      hasPermission(viewer, SOURCE_RULES[refType].permission),
    );
    if (!readable.length) return branches;

    const refs = await this.prisma.customerTimelineEvent.findMany({
      where: { customerId, refType: { in: readable }, refId: { not: null } },
      distinct: ['refType', 'refId'],
      select: { refType: true, refId: true },
    });

    for (const refType of readable) {
      const ids = refs
        .filter((ref) => ref.refType === refType)
        .map((ref) => ref.refId as string);
      if (!ids.length) continue;

      const visible = await SOURCE_RULES[refType].visibleIds(
        this.prisma,
        viewer,
        ids,
      );
      if (visible.length) {
        branches.push({ refType, refId: { in: visible.map((row) => row.id) } });
      }
    }
    return branches;
  }
}
