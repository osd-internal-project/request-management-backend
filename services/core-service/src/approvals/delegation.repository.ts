import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
  TxOption,
} from '@request-management/share';
import type { Delegation } from '@prisma/client';

@Injectable()
export class DelegationRepository extends BaseRepository<
  PrismaService['delegation']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.delegation;
  }

  findForCompany(companyId: string, option?: TxOption): Promise<Delegation[]> {
    return this.findMany(
      { where: { companyId, revokedAt: null }, orderBy: { fromDate: 'desc' } },
      option,
    );
  }

  /**
   * APV-03: the delegation, if any, letting `delegateUserId` act for
   * `delegatorUserId` today.
   *
   * Checked at decision time rather than baked into the step at submit, which
   * is what makes **pending** work re-route to a delegate and not only new
   * work — the case a manager left behind is exactly the one that needs
   * covering.
   */
  findActiveFor(
    companyId: string,
    delegatorUserId: string,
    delegateUserId: string,
    at: Date,
    option?: TxOption,
  ): Promise<Delegation | null> {
    const client = option?.prisma ?? this.prisma;

    return client.delegation.findFirst({
      where: {
        companyId,
        delegatorUserId,
        delegateUserId,
        active: true,
        revokedAt: null,
        fromDate: { lte: at },
        toDate: { gte: at },
      },
    });
  }

  /** Everyone this person may currently act for — drives the inbox. */
  async delegatorsFor(
    companyId: string,
    delegateUserId: string,
    at: Date,
    option?: TxOption,
  ): Promise<string[]> {
    const client = option?.prisma ?? this.prisma;

    const rows = await client.delegation.findMany({
      where: {
        companyId,
        delegateUserId,
        active: true,
        revokedAt: null,
        fromDate: { lte: at },
        toDate: { gte: at },
      },
      select: { delegatorUserId: true },
    });

    return rows.map((row) => row.delegatorUserId);
  }

  /**
   * APV-03 forbids sub-delegation: someone who is already acting as a
   * delegate may not hand that on. Without this the chain of accountability
   * becomes unbounded and the history stops naming anyone real.
   */
  async isActingAsDelegate(
    companyId: string,
    userId: string,
    at: Date,
    option?: TxOption,
  ): Promise<boolean> {
    const client = option?.prisma ?? this.prisma;

    const count = await client.delegation.count({
      where: {
        companyId,
        delegateUserId: userId,
        active: true,
        revokedAt: null,
        fromDate: { lte: at },
        toDate: { gte: at },
      },
    });

    return count > 0;
  }
}
