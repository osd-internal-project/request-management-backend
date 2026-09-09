import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
  TxOption,
} from '@request-management/share';
import type {
  Prisma,
  Request,
  RequestAttachment,
  RequestStatus,
  RequestType,
} from '@prisma/client';

export type RequestWithType = Request & {
  requestType: RequestType;
  attachments: RequestAttachment[];
};

/**
 * A row of §16 หน้าที่ 2, which needs more than the request itself: the clock
 * drives the `ครบกำหนด` badge and the chain drives `ขั้นปัจจุบัน`. Loaded in
 * the same query so the list is one round trip, not one per row.
 */
export type RequestListRow = RequestWithType & {
  /** Who raised it. A list that crosses people is unreadable without a name. */
  requester: { id: string; displayName: string };
  /*
    The other two names, added 9 ก.ย. 2569. The row already carried the ids, so
    a caller with no directory could print "ผู้รับเรื่อง: e0e90f78-98d3-…" and
    nothing better — the tree endpoint was the only place in the API that ever
    answered who a person was.
  */
  receiver: { id: string; displayName: string } | null;
  assignee: { id: string; displayName: string } | null;
  /*
    `breachedAt` travels with the row because it is the fact the `overdue`
    filter tests. Without it a client renders its badge from `state`/`dueAt` and
    disagrees with the list it is rendering.
  */
  slaClock: { state: string; dueAt: Date; breachedAt: Date | null } | null;
  approvalCases: {
    /** The decision endpoint addresses the case, so the row has to carry it. */
    id: string;
    status: string;
    currentStep: number;
    steps: {
      stepNo: number;
      status: string;
      approverRole: string;
      approverUserId: string | null;
      /**
       * Everyone allowed to decide the step.
       *
       * Carried on the list, not only the detail screen, since the row buttons
       * arrived (4 ก.ย. 2569): whether the viewer may approve is the same
       * question `authorise` asks, and answering it from a narrower fact would
       * put an อนุมัติ button on a row that answers `APV_NOT_YOUR_TURN`.
       */
      candidateUserIds: string[];
    }[];
  }[];
};

/**
 * What §16 หน้าที่ 4 needs, derived from the query rather than restated.
 *
 * Writing this shape by hand meant keeping two declarations in step, and they
 * drifted the first time the query changed. `GetPayload` makes the include the
 * single source of truth.
 */
export const REQUEST_DETAIL_INCLUDE = {
  requestType: true,
  attachments: true,
  /*
    The three people a request is about. Absent until 9 ก.ย. 2569, which left
    the detail endpoint answering with uuids while the timeline beneath it
    printed names — the same person, twice, unrecognisably.
  */
  requester: { select: { id: true, displayName: true } },
  receiver: { select: { id: true, displayName: true } },
  assignee: { select: { id: true, displayName: true } },
  approvalCases: {
    orderBy: { createdAt: 'desc' },
    take: 1,
    select: {
      // The screen decides on this case, so it needs its id.
      id: true,
      currentStep: true,
      matrixVersion: true,
      amount: true,
      steps: {
        orderBy: { stepNo: 'asc' },
        select: {
          stepNo: true,
          approverRole: true,
          approverUserId: true,
          status: true,
          decision: true,
          decidedAt: true,
          approver: { select: { displayName: true } },
          // A level can name several people, any one of whom may decide. The
          // screen prints them so "waiting on" is not one name out of three.
          candidateUserIds: true,
        },
      },
    },
  },
  events: {
    orderBy: { createdAt: 'asc' },
    // The timeline names people, not ids — a UUID there is unreadable.
    include: { actor: { select: { displayName: true } } },
  },
  /*
    Comments come with the request rather than from a second call: they are
    drawn on the same timeline as the events, and fetching them separately
    would let the two halves of one list arrive at different times.
  */
  comments: {
    orderBy: { createdAt: 'asc' },
    include: { author: { select: { displayName: true } } },
  },
} satisfies Prisma.RequestInclude;

export type RequestDetail = Prisma.RequestGetPayload<{
  include: typeof REQUEST_DETAIL_INCLUDE;
}>;

@Injectable()
export class RequestRepository extends BaseRepository<
  PrismaService['request']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.request;
  }

  findWithType(id: string, option?: TxOption): Promise<RequestWithType | null> {
    const client = option?.prisma ?? this.prisma;

    return client.request.findUnique({
      where: { id },
      include: { requestType: true, attachments: true },
    });
  }

  /** REQ-07: the request plus everything §16 หน้าที่ 4 draws. */
  /**
   * The id behind a document number, within one company.
   *
   * The external API takes either: a chatbot is handed
   * `REQ-OSD-PS01-26090001` by a person reading it off an email, never a uuid.
   * Pinned to the company because `requestNo` is unique across the database
   * and a number from another company must read as "not found", not as a
   * request the caller then fails to open (SCOPE-03).
   */
  async findIdByNumber(
    requestNo: string,
    companyId: string,
    option?: TxOption,
  ): Promise<string | null> {
    const row = (await this.findFirst(
      { where: { requestNo, companyId }, select: { id: true } },
      option,
    )) as { id: string } | null;

    return row?.id ?? null;
  }

  findDetail(id: string, option?: TxOption): Promise<RequestDetail | null> {
    const client = option?.prisma ?? this.prisma;

    return client.request.findUnique({
      where: { id },
      include: REQUEST_DETAIL_INCLUDE,
    });
  }

  /**
   * A person who may be handed a ticket in this company.
   *
   * Membership, not just existence: SCOPE-03 makes the company boundary
   * absolute, and naming somebody from another company as your receiver would
   * cross it at the moment a request is raised.
   */
  findReceiver(
    userId: string,
    companyId: string,
    option?: TxOption,
  ): Promise<{ id: string } | null> {
    const client = option?.prisma ?? this.prisma;

    return client.user.findFirst({
      where: { id: userId, companies: { some: { companyId } } },
      select: { id: true },
    });
  }

  /** Direct children still running — what blocks a parent's completion. */
  findOpenChildren(
    parentRequestId: string,
    openStatuses: readonly RequestStatus[],
    option?: TxOption,
  ): Promise<{ id: string; requestNo: string | null }[]> {
    const client = option?.prisma ?? this.prisma;

    return client.request.findMany({
      where: { parentRequestId, status: { in: [...openStatuses] } },
      select: { id: true, requestNo: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  search(
    where: Prisma.RequestWhereInput,
    args: { skip: number; take: number },
    option?: TxOption,
  ): Promise<RequestListRow[]> {
    const client = option?.prisma ?? this.prisma;

    return client.request.findMany({
      where,
      include: {
        requestType: true,
        attachments: true,
        requester: { select: { id: true, displayName: true } },
        receiver: { select: { id: true, displayName: true } },
        assignee: { select: { id: true, displayName: true } },
        slaClock: {
          select: { state: true, dueAt: true, breachedAt: true },
        },
        approvalCases: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            id: true,
            status: true,
            currentStep: true,
            steps: {
              orderBy: { stepNo: 'asc' },
              select: {
                stepNo: true,
                status: true,
                approverRole: true,
                approverUserId: true,
                candidateUserIds: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      skip: args.skip,
      take: args.take,
    });
  }

  countWhere(
    where: Prisma.RequestWhereInput,
    option?: TxOption,
  ): Promise<number> {
    return this.count({ where }, option);
  }

  /**
   * How many requests sit at each status, under the caller's own filter.
   *
   * One query rather than one per status. The chatbot's "งานค้างกี่ใบ แยกตาม
   * สถานะ" was eight round trips against a moving table, so the eight answers
   * could disagree with each other — somebody receiving a request between the
   * third call and the fourth was counted twice, or not at all.
   *
   * `groupBy` is reached through the raw client because `BaseRepository` does
   * not expose it. The `where` still arrives from the same place every list and
   * single read gets theirs (SCOPE-02); this method must never build one.
   */
  async countByStatus(
    where: Prisma.RequestWhereInput,
    option?: TxOption,
  ): Promise<Record<string, number>> {
    const client = option?.prisma ?? this.prisma;

    const rows = await client.request.groupBy({
      by: ['status'],
      where,
      _count: { _all: true },
    });

    return Object.fromEntries(rows.map((row) => [row.status, row._count._all]));
  }
}
