import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
  TxOption,
} from '@request-management/share';
import type { OrgUnitScope, Prisma } from '@prisma/client';

/** One end of a grant, named for the admin screen. */
type ScopeEnd = { id: string; name: string; kind: string } | null;
type ScopeUserEnd = {
  id: string;
  displayName: string;
  username: string;
} | null;

/** A grant with both ends resolved to names, for the admin screen. */
export type ScopeWithUnits = OrgUnitScope & {
  viewer: ScopeEnd;
  viewerUser: ScopeUserEnd;
  target: ScopeEnd;
  targetUser: ScopeUserEnd;
};

const UNIT = { select: { id: true, name: true, kind: true } };
const PERSON = { select: { id: true, displayName: true, username: true } };

const WITH_ENDS = {
  viewer: UNIT,
  viewerUser: PERSON,
  target: UNIT,
  targetUser: PERSON,
} satisfies Prisma.OrgUnitScopeInclude;

/**
 * Which groups and people may see which other groups' and people's requests.
 *
 * Replaces `ScopeRuleRepository`, which stored a level per role — a shape that
 * could never express "this group sees that group". The old table is left in
 * place and unread; removing it is a migration of its own.
 */
@Injectable()
export class OrgUnitScopeRepository extends BaseRepository<
  PrismaService['orgUnitScope']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.orgUnitScope;
  }

  /**
   * Every grant this person holds — through any of their groups, or written to
   * them by name.
   *
   * Takes the whole set of groups rather than one id because a grant is
   * inherited downwards: resolving one person means asking for their unit *and*
   * every unit above it, which is one query, not one per level. The personal
   * grants ride along in the same query for the same reason.
   *
   * `viewerUserId` is deliberately not inherited by anything — a grant written
   * to a person is that person's alone.
   */
  findForViewers(
    viewerOrgUnitIds: readonly string[],
    companyId: string,
    /** The caller themselves, for grants written to them by name. */
    viewerUserId?: string,
    option?: TxOption,
  ): Promise<OrgUnitScope[]> {
    const reachedBy: Prisma.OrgUnitScopeWhereInput[] = [];

    if (viewerOrgUnitIds.length) {
      reachedBy.push({ viewerOrgUnitId: { in: [...viewerOrgUnitIds] } });
    }

    if (viewerUserId) reachedBy.push({ viewerUserId });

    /*
      No viewer at all means no grants — never "every grant in the company".
      An empty `OR` matches nothing in Prisma, but relying on that would put a
      disclosure one refactor away.
    */
    if (!reachedBy.length) return Promise.resolve([]);

    return this.findMany(
      { where: { companyId, active: true, OR: reachedBy } },
      option,
    );
  }

  /** The grants written *on* one group, for the screen that edits them. */
  findForViewerWithUnits(
    viewerOrgUnitId: string,
    option?: TxOption,
  ): Promise<ScopeWithUnits[]> {
    return this.findMany(
      {
        where: { viewerOrgUnitId, active: true },
        include: WITH_ENDS,
        orderBy: { createdAt: 'asc' },
      },
      option,
    ) as Promise<ScopeWithUnits[]>;
  }

  /** The grants written *on* one person, for the same screen. */
  findForViewerUserWithUnits(
    viewerUserId: string,
    option?: TxOption,
  ): Promise<ScopeWithUnits[]> {
    return this.findMany(
      {
        where: { viewerUserId, active: true },
        include: WITH_ENDS,
        orderBy: { createdAt: 'asc' },
      },
      option,
    ) as Promise<ScopeWithUnits[]>;
  }
}
