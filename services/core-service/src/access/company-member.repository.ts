import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
  TxOption,
} from '@request-management/share';

/**
 * Read-only: does this person work in this company?
 *
 * Membership rather than `primaryCompanyId`, for the reason AUTH-05 gives —
 * somebody can work in a company that is not their primary one, and naming
 * them on that company's approval ladder is legitimate.
 *
 * Separate from `OrgUnitRepository` because a person is not a group, and the
 * house rule is one repository per table it owns.
 */
@Injectable()
export class CompanyMemberRepository extends BaseRepository<
  PrismaService['user']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.user;
  }

  /**
   * Which of these ids are members of this company.
   *
   * Returns only the ids that pass, so the caller can name the ones that did
   * not — the whole ladder is checked in one query rather than one per level.
   */
  async memberIdsOf(
    ids: readonly string[],
    companyId: string,
    option?: TxOption,
  ): Promise<Set<string>> {
    if (!ids.length) return new Set();

    const rows = (await this.findMany(
      {
        where: { id: { in: [...ids] }, companies: { some: { companyId } } },
        select: { id: true },
      },
      option,
    )) as { id: string }[];

    return new Set(rows.map((row) => row.id));
  }
}
