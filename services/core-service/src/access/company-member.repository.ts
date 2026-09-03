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
   * The people sitting in any of these groups, for a caller with no directory.
   *
   * The external API's receiver picker: a chatbot cannot render a searchable
   * list of four hundred names, so it is handed the members of the receiving
   * team's subtree and nothing else.
   *
   * Company-pinned as well as unit-pinned (SCOPE-03) — a unit id is not proof
   * of company, and the caller supplies it.
   */
  async findInUnits(
    orgUnitIds: readonly string[],
    companyId: string,
    option?: TxOption,
  ): Promise<{ id: string; displayName: string; email: string | null }[]> {
    if (!orgUnitIds.length) return [];

    return await this.findMany(
      {
        where: {
          orgUnitId: { in: [...orgUnitIds] },
          status: 'ACTIVE',
          companies: { some: { companyId } },
        },
        select: { id: true, displayName: true, email: true },
        orderBy: { displayName: 'asc' },
      },
      option,
    );
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
