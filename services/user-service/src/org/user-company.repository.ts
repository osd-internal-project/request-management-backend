import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
  TxOption,
} from '@request-management/share';
import type { Company, UserCompany } from '@prisma/client';

export type MembershipWithCompany = UserCompany & { company: Company };

/** AUTH-05: which companies a user belongs to, and which one is primary. */
@Injectable()
export class UserCompanyRepository extends BaseRepository<
  PrismaService['userCompany']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.userCompany;
  }

  findForUser(
    userId: string,
    option?: TxOption,
  ): Promise<MembershipWithCompany[]> {
    return this.findMany(
      {
        where: { userId, company: { active: true } },
        include: { company: true },
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
      },
      option,
    ) as Promise<MembershipWithCompany[]>;
  }

  /** Every company the user belongs to, active or not. */
  async companyIdsOf(userId: string, option?: TxOption): Promise<string[]> {
    const rows = await this.findMany(
      { where: { userId }, select: { companyId: true } },
      option,
    );
    return rows.map((row) => row.companyId);
  }

  /** Replaces a user's memberships wholesale; the caller supplies the tx. */
  async replaceForUser(
    userId: string,
    companyIds: readonly string[],
    primaryCompanyId: string | null,
    option?: TxOption,
  ): Promise<void> {
    const client = option?.prisma ?? this.prisma;

    await client.userCompany.deleteMany({
      where: { userId, companyId: { notIn: [...companyIds] } },
    });

    for (const companyId of companyIds) {
      await client.userCompany.upsert({
        where: { userId_companyId: { userId, companyId } },
        update: { isPrimary: companyId === primaryCompanyId },
        create: {
          userId,
          companyId,
          isPrimary: companyId === primaryCompanyId,
        },
      });
    }
  }

  /**
   * Takes a person out of one company: its role grants, the membership, and
   * any primary / last / placement that pointed there. Other companies stay.
   * The caller supplies the tx.
   */
  async detachFromCompany(
    userId: string,
    companyId: string,
    option?: TxOption,
  ): Promise<void> {
    const client = option?.prisma ?? this.prisma;

    await client.userRole.deleteMany({ where: { userId, companyId } });
    await client.userCompany.deleteMany({ where: { userId, companyId } });
    await client.user.updateMany({
      where: { id: userId, primaryCompanyId: companyId },
      data: { primaryCompanyId: null },
    });
    await client.user.updateMany({
      where: { id: userId, lastCompanyId: companyId },
      data: { lastCompanyId: null },
    });
    await client.user.updateMany({
      where: { id: userId, orgUnit: { companyId } },
      data: { orgUnitId: null },
    });
  }
}
