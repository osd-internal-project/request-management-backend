import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
  TxOption,
} from '@request-management/share';
import type { BiDashboard, BiDashboardAudience, OrgUnit } from '@prisma/client';

/** A dashboard row with its audience units resolved to names, for admin. */
export type BiDashboardWithAudience = BiDashboard & {
  audiences: (BiDashboardAudience & {
    orgUnit: Pick<OrgUnit, 'id' | 'name' | 'kind'>;
  })[];
};

/** Every `bi_dashboards` query lives here. */
@Injectable()
export class BiDashboardRepository extends BaseRepository<
  PrismaService['biDashboard']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.biDashboard;
  }

  /**
   * The dashboards a member of `orgUnitId` may see.
   *
   * A dashboard with no audience rows belongs to the whole company. One scoped
   * to a unit is visible to that unit's entire subtree, so the member's side
   * of the test is "any ancestor of my unit, including it" — resolved through
   * `org_closure`, the same maths as data scope (§6.2). A caller with no org
   * unit yet sees only the unscoped dashboards.
   */
  async findVisible(
    companyId: string,
    orgUnitId: string | null,
  ): Promise<BiDashboard[]> {
    const ancestors = orgUnitId
      ? await this.prisma.orgClosure.findMany({
          where: { descendantId: orgUnitId },
          select: { ancestorId: true },
        })
      : [];
    const ancestorIds = ancestors.map((row) => row.ancestorId);

    return this.findMany({
      where: {
        companyId,
        active: true,
        OR: [
          { audiences: { none: {} } },
          ...(ancestorIds.length
            ? [{ audiences: { some: { orgUnitId: { in: ancestorIds } } } }]
            : []),
        ],
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  /** Every dashboard in one company, inactive included — the admin list. */
  findForCompany(
    companyId: string,
    option?: TxOption,
  ): Promise<BiDashboardWithAudience[]> {
    return this.findMany(
      {
        where: { companyId },
        include: {
          audiences: {
            include: {
              orgUnit: { select: { id: true, name: true, kind: true } },
            },
          },
        },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      },
      option,
    ) as Promise<BiDashboardWithAudience[]>;
  }

  /**
   * One dashboard by id, but only within the caller's companies — an id from
   * another company answers `null`, which the service turns into 404 rather
   * than 403 (SCOPE-03: existence is not disclosed).
   */
  findOwn(
    id: string,
    memberCompanyIds: readonly string[],
    option?: TxOption,
  ): Promise<BiDashboardWithAudience | null> {
    return this.findFirst(
      {
        where: { id, companyId: { in: [...memberCompanyIds] } },
        include: {
          audiences: {
            include: {
              orgUnit: { select: { id: true, name: true, kind: true } },
            },
          },
        },
      },
      option,
    ) as Promise<BiDashboardWithAudience | null>;
  }

  /**
   * The active org units of `orgUnitIds` that belong to `companyId` — what
   * audience validation checks a submitted id list against.
   */
  async findAssignableUnits(
    orgUnitIds: readonly string[],
    companyId: string,
  ): Promise<Pick<OrgUnit, 'id' | 'name' | 'kind'>[]> {
    if (!orgUnitIds.length) return [];

    return this.prisma.orgUnit.findMany({
      where: { id: { in: [...orgUnitIds] }, companyId, active: true },
      select: { id: true, name: true, kind: true },
    });
  }

  /** The active units of one company, for the audience picker. */
  findCompanyUnits(
    companyId: string,
  ): Promise<Pick<OrgUnit, 'id' | 'name' | 'kind' | 'parentId'>[]> {
    return this.prisma.orgUnit.findMany({
      where: { companyId, active: true },
      select: { id: true, name: true, kind: true, parentId: true },
      orderBy: { name: 'asc' },
    });
  }

  /** Replaces a dashboard's audience set. Call inside the edit's transaction. */
  async replaceAudiences(
    dashboardId: string,
    orgUnitIds: readonly string[],
    option: TxOption,
  ): Promise<void> {
    const client = option.prisma ?? this.prisma;

    await client.biDashboardAudience.deleteMany({ where: { dashboardId } });

    if (orgUnitIds.length) {
      await client.biDashboardAudience.createMany({
        data: orgUnitIds.map((orgUnitId) => ({ dashboardId, orgUnitId })),
      });
    }
  }
}
