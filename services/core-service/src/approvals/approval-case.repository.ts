import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
  TxOption,
} from '@request-management/share';
import type { ApprovalCase, ApprovalStep, Prisma } from '@prisma/client';

export type CaseWithSteps = ApprovalCase & { steps: ApprovalStep[] };

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

  countWhere(
    where: Prisma.ApprovalCaseWhereInput,
    option?: TxOption,
  ): Promise<number> {
    return this.count({ where }, option);
  }
}
