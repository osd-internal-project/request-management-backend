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
  RequestEvent,
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
  slaClock: { state: string; dueAt: Date } | null;
  approvalCases: {
    currentStep: number;
    steps: {
      stepNo: number;
      approverRole: string;
      approverUserId: string | null;
    }[];
  }[];
};

export type RequestDetail = RequestWithType & {
  events: RequestEvent[];
};

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

  /** REQ-07: the request plus its append-only timeline, oldest first. */
  findDetail(id: string, option?: TxOption): Promise<RequestDetail | null> {
    const client = option?.prisma ?? this.prisma;

    return client.request.findUnique({
      where: { id },
      include: {
        requestType: true,
        attachments: true,
        events: { orderBy: { createdAt: 'asc' } },
      },
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
        slaClock: { select: { state: true, dueAt: true } },
        approvalCases: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            currentStep: true,
            steps: {
              orderBy: { stepNo: 'asc' },
              select: {
                stepNo: true,
                approverRole: true,
                approverUserId: true,
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
}
