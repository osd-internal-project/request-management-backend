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
  async findEffective(
    companyId: string,
    subjectType: string,
    at: Date,
    option?: TxOption,
  ): Promise<ApprovalMatrix | null> {
    const client = option?.prisma ?? this.prisma;

    const latest = await client.approvalMatrix.findFirst({
      where: {
        companyId,
        subjectType,
        publishedAt: { not: null },
        effectiveFrom: { lte: at },
      },
      orderBy: [{ effectiveFrom: 'desc' }, { version: 'desc' }],
    });
    // CD-80 — the latest version retires the ladder: no stage, not the one
    // before it. Every caller (route, preview, `hasPublishedMatrix`) sees the
    // same answer because they all come through here.
    return latest?.retired ? null : latest;
  }

  /** Highest version number so far, or 0 — the next publish is this plus one. */
  /**
   * How many versions exist for a subject, published or not.
   *
   * Used to refuse deleting the request type a matrix routes: the matrix
   * outlives the type and would be left addressing nothing.
   */
  countForSubject(subjectType: string): Promise<number> {
    return this.count({ where: { subjectType } });
  }

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

  /** The requester form's fields plus every step form of the type's latest flow in this company. */
  async formFieldsOfType(
    typeCode: string,
    companyId: string,
  ): Promise<string[]> {
    const type = await this.prisma.requestType.findUnique({
      where: { code: typeCode },
      select: {
        formSchema: true,
        flowVersions: {
          where: { companyId },
          orderBy: { version: 'desc' },
          take: 1,
          select: { steps: { select: { formSchema: true } } },
        },
      },
    });
    if (!type) return [];

    const schemas = [
      type.formSchema,
      ...(type.flowVersions[0]?.steps.map((step) => step.formSchema) ?? []),
    ];
    return schemas.flatMap((schema) => Object.keys(propertiesOf(schema)));
  }
}

function propertiesOf(schema: unknown): Record<string, unknown> {
  const properties =
    schema && typeof schema === 'object' && 'properties' in schema
      ? schema.properties
      : null;
  return properties &&
    typeof properties === 'object' &&
    !Array.isArray(properties)
    ? { ...properties }
    : {};
}
