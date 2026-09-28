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

  /** These people, if they are active members of this company — same shape as `findInUnits`. */
  async findActiveByIds(
    ids: readonly string[],
    companyId: string,
    option?: TxOption,
  ): Promise<{ id: string; displayName: string; email: string | null }[]> {
    if (!ids.length) return [];

    return await this.findMany(
      {
        where: {
          id: { in: [...ids] },
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
  /** The group this person sits in, if they belong to the company. */
  async orgUnitIdOf(userId: string, companyId: string): Promise<string | null> {
    const row = (await this.findFirst({
      where: { id: userId, companies: { some: { companyId } } },
      select: { orgUnitId: true },
    })) as { orgUnitId: string | null } | null;
    return row?.orgUnitId ?? null;
  }

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

  /**
   * What to call these people, for ids this service resolved itself.
   *
   * core-service asks user-service for identity facts (§03), and for the
   * approval chain that arrives as `GET /internal/org/approval-context`. But
   * that payload names only the ids *it* produced — the requester's personal
   * supervisor chain and the role holders. A `supervisor:N` ladder level is
   * resolved here instead, from `OrgUnit.managerUserId`, and those ids were
   * never in it: the preview showed `supervisor:1` where a name belonged.
   *
   * Read locally rather than through a new user-service route because the
   * persisted view already does exactly that — `ApprovalStep.approver` is a
   * Prisma relation on the same database (`request.repository.ts`). A remote
   * hop here would make the same two screens name the same person differently.
   *
   * Company-pinned like `memberIdsOf` (SCOPE-03): an id from outside this
   * company answers with no name, and the caller falls back to the level's
   * label. Losing a name is the safer failure.
   */
  async displayNamesOf(
    ids: readonly string[],
    companyId: string,
    option?: TxOption,
  ): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map();

    const rows = (await this.findMany(
      {
        where: { id: { in: unique }, companies: { some: { companyId } } },
        select: { id: true, displayName: true },
      },
      option,
    )) as { id: string; displayName: string }[];

    return new Map(rows.map((row) => [row.id, row.displayName]));
  }
}
