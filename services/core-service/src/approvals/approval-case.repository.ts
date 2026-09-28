import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
  TxOption,
} from '@request-management/share';
import { Prisma } from '@prisma/client';
import type { ApprovalCase, ApprovalStep } from '@prisma/client';

export type CaseWithSteps = ApprovalCase & { steps: ApprovalStep[] };

/** APV-06 (CD-45) — one row of the decision log. */
export const DECISION_LOG_SELECT = {
  id: true,
  stepNo: true,
  approverRole: true,
  approverUserId: true,
  candidateUserIds: true,
  decision: true,
  note: true,
  decidedAt: true,
  decidedByUserId: true,
  delegationId: true,
  approver: { select: { displayName: true } },
  decidedBy: { select: { displayName: true } },
  case: {
    select: {
      id: true,
      subjectType: true,
      amount: true,
      currency: true,
      status: true,
      matrixVersion: true,
      snapshotVersion: true,
      snapshotHash: true,
      request: { select: { id: true, requestNo: true, typeCode: true } },
    },
  },
} satisfies Prisma.ApprovalStepSelect;

export type DecisionLogStep = Prisma.ApprovalStepGetPayload<{
  select: typeof DECISION_LOG_SELECT;
}>;

@Injectable()
export class ApprovalCaseRepository extends BaseRepository<
  PrismaService['approvalCase']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.approvalCase;
  }

  findWithSteps(id: string, option?: TxOption): Promise<CaseWithSteps | null> {
    const client = option?.prisma ?? this.prisma;

    return client.approvalCase.findUnique({
      where: { id },
      include: { steps: { orderBy: { stepNo: 'asc' } } },
    });
  }

  /**
   * APV-04: the cases a batch decision names, loaded together.
   *
   * Fetched in one query rather than per id so a batch of fifty is one round
   * trip; each is still decided in its own transaction.
   */
  findManyWithSteps(
    ids: readonly string[],
    companyId: string,
    option?: TxOption,
  ): Promise<CaseWithSteps[]> {
    const client = option?.prisma ?? this.prisma;

    return client.approvalCase.findMany({
      where: { id: { in: [...ids] }, companyId },
      include: { steps: { orderBy: { stepNo: 'asc' } } },
    });
  }

  search(
    where: Prisma.ApprovalCaseWhereInput,
    args: { skip: number; take: number },
    option?: TxOption,
  ): Promise<CaseWithSteps[]> {
    const client = option?.prisma ?? this.prisma;

    return client.approvalCase.findMany({
      where,
      include: { steps: { orderBy: { stepNo: 'asc' } } },
      orderBy: { createdAt: 'desc' },
      skip: args.skip,
      take: args.take,
    });
  }

  /**
   * APV-06 (CD-45) — decided steps with what the decision log needs: the case,
   * its request number, and who was named vs who acted. Newest decision first.
   */
  decidedSteps(
    where: Prisma.ApprovalStepWhereInput,
    args: { skip: number; take: number },
  ) {
    return this.prisma.approvalStep.findMany({
      where,
      select: DECISION_LOG_SELECT,
      orderBy: [{ decidedAt: 'desc' }, { stepNo: 'asc' }],
      skip: args.skip,
      take: args.take,
    });
  }

  /**
   * Step ids decided on a given basis — "who acted vs who was named" compares
   * two columns and an array on the same row, which a Prisma `where` cannot
   * say. Bounded by company and decision window like every other read here.
   */
  async stepIdsByBasis(
    companyId: string,
    window: { start: Date; end: Date },
    basis: 'chain' | 'delegate' | 'scope_grant',
  ): Promise<string[]> {
    // COALESCE: a step routed to candidates has no `approverUserId`, and
    // `x = NULL` is NULL, not false — `NOT (NULL OR false)` would silently drop
    // exactly the out-of-chain rows this filter exists to find.
    const named = Prisma.sql`(s."decidedByUserId" IS NULL
      OR COALESCE(s."decidedByUserId" = s."approverUserId", false)
      OR COALESCE(s."decidedByUserId" = ANY(s."candidateUserIds"), false))`;
    const condition =
      basis === 'delegate'
        ? Prisma.sql`s."delegationId" IS NOT NULL`
        : basis === 'chain'
          ? Prisma.sql`s."delegationId" IS NULL AND ${named}`
          : Prisma.sql`s."delegationId" IS NULL AND NOT ${named}`;

    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT s.id FROM approval_steps s
      JOIN approval_cases c ON c.id = s."caseId"
      WHERE c."companyId" = ${companyId}
        AND s.decision IS NOT NULL
        AND s."decidedAt" >= ${window.start}
        AND s."decidedAt" < ${window.end}
        AND ${condition}
    `;
    return rows.map((row) => row.id);
  }

  countDecidedSteps(where: Prisma.ApprovalStepWhereInput): Promise<number> {
    return this.prisma.approvalStep.count({ where });
  }

  countWhere(
    where: Prisma.ApprovalCaseWhereInput,
    option?: TxOption,
  ): Promise<number> {
    return this.count({ where }, option);
  }
}
