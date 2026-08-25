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
}
