import { Injectable, Logger } from '@nestjs/common';
import {
  paginated,
  Paginated,
  toSkipTake,
  TxOption,
} from '@request-management/share';
import type { AuditLog, Prisma } from '@prisma/client';
import { AuditLogRepository } from './audit.repository';
import { AuditEventType } from './audit-events';
import { QueryAuditLogDto } from './dto/query-audit-log.dto';

export interface AuditEntry {
  eventType: AuditEventType;
  companyId?: string | null;
  actorId?: string | null;
  actorUsername?: string | null;
  resourceType?: string;
  resourceId?: string;
  before?: unknown;
  after?: unknown;
  ip?: string;
  userAgent?: string;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly repository: AuditLogRepository) {}

  /**
   * Appends one entry. Pass `option` to join the caller's transaction so the
   * log entry and the change it describes commit together — a role grant that
   * succeeded with no audit row would defeat ROLE-05.
   *
   * Outside a transaction a failure is swallowed and logged: audit is not
   * worth failing a user's request over once the change itself is committed.
   */
  async record(entry: AuditEntry, option?: TxOption): Promise<void> {
    const data: Prisma.AuditLogUncheckedCreateInput = {
      eventType: entry.eventType,
      companyId: entry.companyId ?? null,
      actorId: entry.actorId ?? null,
      actorUsername: entry.actorUsername ?? null,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId,
      before: entry.before ?? undefined,
      after: entry.after ?? undefined,
      ip: entry.ip,
      userAgent: entry.userAgent,
    };

    if (option?.prisma) {
      await this.repository.append(data, option);
      return;
    }

    try {
      await this.repository.append(data);
    } catch (error) {
      this.logger.error(
        `Failed to write audit entry ${entry.eventType}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  async search(query: QueryAuditLogDto): Promise<Paginated<AuditLog>> {
    const where: Prisma.AuditLogWhereInput = {
      ...(query.actor_id ? { actorId: query.actor_id } : {}),
      ...(query.event_type ? { eventType: query.event_type } : {}),
      ...(query.resource_type ? { resourceType: query.resource_type } : {}),
      ...(query.resource_id ? { resourceId: query.resource_id } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.repository.search(where, toSkipTake(query)),
      this.repository.countWhere(where),
    ]);

    return paginated(rows, query, total);
  }
}
