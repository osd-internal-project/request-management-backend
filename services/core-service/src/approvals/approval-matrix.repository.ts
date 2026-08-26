import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
  TxOption,
} from '@request-management/share';
import type { ApprovalMatrix } from '@prisma/client';

/** Every `approval_matrices` query lives here. */
@Injectable()
export class ApprovalMatrixRepository extends BaseRepository<
  PrismaService['approvalMatrix']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.approvalMatrix;
  }

  /** Every version of every ladder in one company, newest first. */
  findForCompany(
    companyId: string,
    subjectType?: string,
    option?: TxOption,
  ): Promise<ApprovalMatrix[]> {
    return this.findMany(
      {
        where: { companyId, ...(subjectType ? { subjectType } : {}) },
        orderBy: [{ subjectType: 'asc' }, { version: 'desc' }],
      },
      option,
    );
  }

  /**
   * The version in force for a subject right now.
   *
   * "In force" means published, effective already, and the highest version
   * among those — an unpublished draft or a future-dated version must never
   * route a case. A case that opens against this keeps `matrixVersion`, so a
   * later publish cannot re-judge work already in flight.
   */
  findEffective(
    companyId: string,
    subjectType: string,
    at: Date,
    option?: TxOption,
  ): Promise<ApprovalMatrix | null> {
    const client = option?.prisma ?? this.prisma;

    return client.approvalMatrix.findFirst({
      where: {
        companyId,
        subjectType,
        publishedAt: { not: null },
        effectiveFrom: { lte: at },
      },
      orderBy: [{ effectiveFrom: 'desc' }, { version: 'desc' }],
    });
  }

  /** Highest version number so far, or 0 — the next publish is this plus one. */
  async latestVersion(
    companyId: string,
    subjectType: string,
    option?: TxOption,
  ): Promise<number> {
    const client = option?.prisma ?? this.prisma;

    const latest = await client.approvalMatrix.findFirst({
      where: { companyId, subjectType },
      orderBy: { version: 'desc' },
      select: { version: true },
    });

    return latest?.version ?? 0;
  }
}
