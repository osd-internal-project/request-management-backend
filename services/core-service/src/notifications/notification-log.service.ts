import { Injectable } from '@nestjs/common';
import {
  paginated,
  PrismaService,
  resolveTargetCompany,
  toSkipTake,
} from '@request-management/share';
import type { Paginated, Principal } from '@request-management/share';
import type { Prisma } from '@prisma/client';
import { NotificationLogQueryDto } from './dto/notification.dto';

export interface NotificationLogRow {
  id: string;
  created_at: string;
  recipient: {
    id: string;
    display_name: string;
    username: string;
    email: string | null;
  };
  event_type: string;
  title: string;
  body: string;
  resource_type: string | null;
  resource_id: string | null;
  /** The first time it was read; null = never. */
  read_at: string | null;
  /** null on a read row = read before CD-55 recorded how. */
  read_via: 'opened' | 'mark_all' | null;
  deliveries: {
    channel: string;
    target: string;
    status: string;
    error: string | null;
    sent_at: string | null;
    created_at: string;
  }[];
}

/**
 * CD-55 — บันทึกการแจ้งเตือน: ส่งถึงใคร เมื่อไร ช่องทางใด อ่านแล้วหรือยัง.
 *
 * The evidence for "I was never told". Everything here was already written
 * at send time (SUP-03's delivery log) — this is the read side, for
 * `audit.read`, pinned to one company like every other audit read.
 *
 * Read-only by design, like `/audit-logs`: there is no route that edits or
 * removes a notification row, and there must not be one.
 */
@Injectable()
export class NotificationLogService {
  constructor(private readonly prisma: PrismaService) {}

  async search(
    query: NotificationLogQueryDto,
    actor: Principal,
  ): Promise<Paginated<NotificationLogRow>> {
    const companyId = resolveTargetCompany(actor, query.company_id);
    const { skip, take } = toSkipTake(query);
    const q = query.q?.trim();

    const where: Prisma.NotificationWhereInput = {
      companyId,
      ...(query.user_id ? { userId: query.user_id } : {}),
      ...(query.event_type ? { eventType: query.event_type } : {}),
      ...(query.resource_type ? { resourceType: query.resource_type } : {}),
      ...(query.resource_id ? { resourceId: query.resource_id } : {}),
      ...(query.read === 'unread'
        ? { readAt: null }
        : query.read
          ? { readVia: query.read }
          : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
      ...(q
        ? {
            OR: [
              { title: { contains: q, mode: 'insensitive' } },
              {
                user: {
                  OR: [
                    { displayName: { contains: q, mode: 'insensitive' } },
                    { username: { contains: q, mode: 'insensitive' } },
                    { email: { contains: q, mode: 'insensitive' } },
                  ],
                },
              },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        include: {
          user: {
            select: {
              id: true,
              displayName: true,
              username: true,
              email: true,
            },
          },
          deliveries: { orderBy: { createdAt: 'asc' } },
        },
      }),
      this.prisma.notification.count({ where }),
    ]);

    return paginated(
      rows.map((row) => ({
        id: row.id,
        created_at: row.createdAt.toISOString(),
        recipient: {
          id: row.user.id,
          display_name: row.user.displayName,
          username: row.user.username,
          email: row.user.email,
        },
        event_type: row.eventType,
        title: row.title,
        body: row.body,
        resource_type: row.resourceType,
        resource_id: row.resourceId,
        read_at: row.readAt?.toISOString() ?? null,
        read_via: row.readVia,
        deliveries: row.deliveries.map((delivery) => ({
          channel: delivery.channel,
          target: delivery.target,
          status: delivery.status,
          error: delivery.error,
          sent_at: delivery.sentAt?.toISOString() ?? null,
          created_at: delivery.createdAt.toISOString(),
        })),
      })),
      query,
      total,
    );
  }
}
