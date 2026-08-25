import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
  TxOption,
} from '@request-management/share';
import type { AuditLog, Prisma } from '@prisma/client';

/**
 * SUP-04. Note what is **absent**: no update, no delete, no upsert wrapper.
 * `BaseRepository` supplies those generically, but nothing here or above
 * exposes them for audit rows, and no controller route reaches them — the
 * log is append-only by construction, not by convention.
 */
@Injectable()
export class AuditLogRepository extends BaseRepository<
  PrismaService['auditLog']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.auditLog;
  }

  append(
    data: Prisma.AuditLogUncheckedCreateInput,
    option?: TxOption,
  ): Promise<AuditLog> {
    return this.create({ data }, option);
  }

  search(
    where: Prisma.AuditLogWhereInput,
    args: { skip: number; take: number },
    option?: TxOption,
  ): Promise<AuditLog[]> {
    return this.findMany(
      {
        where,
        skip: args.skip,
        take: args.take,
        orderBy: { createdAt: 'desc' },
      },
      option,
    );
  }

  countWhere(
    where: Prisma.AuditLogWhereInput,
    option?: TxOption,
  ): Promise<number> {
    return this.count({ where }, option);
  }
}
