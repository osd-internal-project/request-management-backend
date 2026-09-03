import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
  TxOption,
} from '@request-management/share';
import type { OrgUnit } from '@prisma/client';

/**
 * Read-only access to the org chart from core-service.
 *
 * The chart is user-service's to maintain (D-08) and nothing here writes to
 * it. This exists so that a `ทีมผู้รับ` arriving on a request can be checked
 * against real, active units of the caller's own company before it is stored —
 * `RequestType.receiver_org_unit_id` has been written straight through without
 * that check since the foundation migration, which is how a type could point
 * at a unit in another company and nothing said so.
 *
 * `BiDashboardRepository.findAssignableUnits` validates dashboard audiences
 * across the same boundary for the same reason.
 */
@Injectable()
export class OrgUnitRepository extends BaseRepository<
  PrismaService['orgUnit']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.orgUnit;
  }

  /**
   * A group and every group above it, nearest first.
   *
   * What "a type may be raised by group X **and everything under it**" needs:
   * asking whether any of the requester's ancestors is on the type's list is
   * one `IN`, whereas expanding each named group's descendants would be a
   * query per group on every submit screen.
   */
  async ancestorIdsOf(orgUnitId: string): Promise<string[]> {
    const rows = await this.prisma.orgClosure.findMany({
      where: { descendantId: orgUnitId },
      select: { ancestorId: true },
      orderBy: { depth: 'asc' },
    });

    return rows.map((row) => row.ancestorId);
  }

  /**
   * The head of each of these groups, in the order the groups were given.
   *
   * A group with nobody in charge simply contributes nobody — the caller
   * decides whether that is a gap worth refusing over, because it means
   * different things to an approval level and to the org screen.
   */
  async managersOf(orgUnitIds: readonly string[]): Promise<string[]> {
    if (!orgUnitIds.length) return [];

    const units = await this.findMany({
      where: { id: { in: [...orgUnitIds] }, managerUserId: { not: null } },
      select: { id: true, managerUserId: true },
    });

    const byId = new Map(
      (units as { id: string; managerUserId: string | null }[]).map((unit) => [
        unit.id,
        unit.managerUserId,
      ]),
    );

    return orgUnitIds
      .map((id) => byId.get(id))
      .filter((userId): userId is string => Boolean(userId));
  }

  /**
   * The unit, only if it is active and belongs to `companyId`.
   *
   * Null covers "does not exist", "belongs to another company" and "has been
   * deactivated" alike — the caller turns all three into the same validation
   * failure, because distinguishing them would disclose what exists elsewhere
   * (SCOPE-03).
   */
  /**
   * A group and everything beneath it, from the closure table.
   *
   * The mirror of {@link ancestorIdsOf}, and used for the opposite question:
   * "who could receive this?" — a type names a receiving ฝ่าย, and the people
   * who can actually take the work sit in แผนก and ตำแหน่ง under it.
   */
  async descendantIdsOf(orgUnitId: string): Promise<string[]> {
    const rows = await this.prisma.orgClosure.findMany({
      where: { ancestorId: orgUnitId },
      select: { descendantId: true },
    });

    return rows.map((row) => row.descendantId);
  }

  /**
   * Which of these ids are assignable groups of this company.
   *
   * The plural of {@link findAssignable}, for validating a whole approval
   * ladder in one query rather than one per level. Returns only the ids that
   * pass, so the caller can name the ones that did not.
   */
  async assignableIdsOf(
    ids: readonly string[],
    companyId: string,
    option?: TxOption,
  ): Promise<Set<string>> {
    if (!ids.length) return new Set();

    const rows = (await this.findMany(
      {
        where: { id: { in: [...ids] }, companyId, active: true },
        select: { id: true },
      },
      option,
    )) as { id: string }[];

    return new Set(rows.map((row) => row.id));
  }

  findAssignable(
    id: string,
    companyId: string,
    option?: TxOption,
  ): Promise<Pick<OrgUnit, 'id' | 'name'> | null> {
    return this.findFirst(
      {
        where: { id, companyId, active: true },
        select: { id: true, name: true },
      },
      option,
    );
  }
}
