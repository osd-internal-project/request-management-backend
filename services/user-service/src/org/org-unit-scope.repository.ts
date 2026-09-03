import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
  TxOption,
} from '@request-management/share';
import type { OrgUnitScope, Prisma } from '@prisma/client';

/** A grant with both group names attached, for the admin screen. */
export type ScopeWithUnits = OrgUnitScope & {
  viewer: { id: string; name: string; kind: string };
  target: { id: string; name: string; kind: string };
};

const WITH_UNITS = {
  viewer: { select: { id: true, name: true, kind: true } },
  target: { select: { id: true, name: true, kind: true } },
} satisfies Prisma.OrgUnitScopeInclude;

/**
 * Which groups may see which other groups' requests.
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
   * Every grant held by any of these groups.
   *
   * Takes the whole set rather than one id because a grant is inherited
   * downwards: resolving one person means asking for their unit *and* every
   * unit above it, which is one query, not one per level.
   */
  findForViewers(
    viewerOrgUnitIds: readonly string[],
    companyId: string,
    option?: TxOption,
  ): Promise<OrgUnitScope[]> {
    if (!viewerOrgUnitIds.length) return Promise.resolve([]);

    return this.findMany(
      {
        where: {
          companyId,
          active: true,
          viewerOrgUnitId: { in: [...viewerOrgUnitIds] },
        },
      },
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
        include: WITH_UNITS,
        orderBy: { createdAt: 'asc' },
      },
      option,
    ) as Promise<ScopeWithUnits[]>;
  }
}
