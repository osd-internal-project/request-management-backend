import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../modules/prisma/prisma.service';
import { TxOption } from '../modules/prisma/types';

/** One entry in the shared append-only log (SUP-04). */
export interface AuditEntry {
  readonly eventType: string;
  readonly companyId?: string | null;
  readonly actorId?: string | null;
  readonly actorUsername?: string | null;
  readonly resourceType?: string;
  readonly resourceId?: string;
  readonly before?: Prisma.InputJsonValue;
  readonly after?: Prisma.InputJsonValue;
  readonly ip?: string;
  readonly userAgent?: string;
}

/**
 * The actor fields for an audit entry, derived from a principal.
 *
 * A service account has **no `User` row** — its `userId` is the Keycloak
 * subject of a machine credential, and writing it to `actorId` violates the
 * foreign key. The identity is not lost: it moves to `actorUsername`, which is
 * where a reader would look anyway ("service-account-request-form").
 *
 * Exists so no call site has to remember this. Getting it wrong fails the
 * whole transaction the audit entry belongs to, which turns a bookkeeping
 * detail into a broken feature.
 */
export function auditActor(principal: {
  userId: string;
  username: string;
  isServiceAccount: boolean;
}): { actorId: string | null; actorUsername: string } {
  return {
    actorId: principal.isServiceAccount ? null : principal.userId,
    actorUsername: principal.username,
  };
}

/**
 * Writes to the single shared `audit_logs` table (SUP-04).
 *
 * There is deliberately **no update and no delete method** — the invariant is
 * structural, not a convention someone has to remember. Both services write
 * here so that "one append-only audit log, searchable by actor, event type and
 * period" stays literally true rather than becoming two logs that have to be
 * stitched together at query time.
 *
 * Inside a transaction the write joins it, so an audit entry and the change it
 * describes commit together or not at all. Outside one, a failure is logged
 * rather than thrown: losing the record of an action is bad, but failing the
 * action because its bookkeeping failed is worse.
 */
@Injectable()
export class AuditWriter {
  private readonly logger = new Logger(AuditWriter.name);

  constructor(private readonly prisma: PrismaService) {}

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
      await option.prisma.auditLog.create({ data });
      return;
    }

    try {
      await this.prisma.auditLog.create({ data });
    } catch (error) {
      this.logger.error(
        `Failed to write audit entry ${entry.eventType}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }
}
