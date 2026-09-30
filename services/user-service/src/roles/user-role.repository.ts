import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
  TxOption,
} from '@request-management/share';
import type {
  Role,
  RoleGrantSource,
  RolePermission,
  UserRole,
} from '@prisma/client';

export type UserRoleWithRole = UserRole & {
  role: Role & { permissions: RolePermission[] };
};

/** One row of screen A4's "ผู้ใช้ใน role นี้" panel. */
export interface RoleHolder {
  readonly userId: string;
  readonly username: string;
  readonly displayName: string;
  /** `KEYCLOAK_MAPPING` earns the "จาก Keycloak" badge; `MANUAL` gets "ผูกมือ" + ถอน. */
  readonly source: RoleGrantSource;
  readonly grantedAt: Date;
  readonly grantedByDisplayName: string | null;
}

@Injectable()
export class UserRoleRepository extends BaseRepository<
  PrismaService['userRole']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.userRole;
  }

  /**
   * ROLE-04: a user's roles **in one company**. Permissions are resolved from
   * this and nothing else, which is what stops a manager in company A from
   * acting as a manager in company B.
   */
  findForUserInCompany(
    userId: string,
    companyId: string,
    option?: TxOption,
  ): Promise<UserRoleWithRole[]> {
    return this.findMany(
      {
        where: { userId, companyId, role: { active: true } },
        include: { role: { include: { permissions: true } } },
      },
      option,
    ) as Promise<UserRoleWithRole[]>;
  }

  /**
   * The same answer as {@link findForUserInCompany} for a whole list of people,
   * in one query.
   *
   * Screen A3's member panel asked per person, which was two round trips per
   * member — a seventy-person department cost a hundred and forty for one
   * panel. Grouped in memory afterwards because Prisma has no `groupBy` that
   * carries the included role.
   */
  async findForUsersInCompany(
    userIds: readonly string[],
    companyId: string,
    option?: TxOption,
  ): Promise<Map<string, UserRoleWithRole[]>> {
    const grouped = new Map<string, UserRoleWithRole[]>();
    if (!userIds.length) return grouped;

    const rows = (await this.findMany(
      {
        where: {
          userId: { in: [...new Set(userIds)] },
          companyId,
          role: { active: true },
        },
        include: { role: { include: { permissions: true } } },
      },
      option,
    )) as UserRoleWithRole[];

    for (const row of rows) {
      grouped.set(row.userId, [...(grouped.get(row.userId) ?? []), row]);
    }

    return grouped;
  }

  /**
   * Everyone holding a role code in one company (ROLE-04).
   *
   * Ordered oldest-grant-first so the answer is stable between calls — an
   * approval chain that named a different CFO on each submit would be
   * impossible to reason about afterwards.
   */
  async holdersOfRole(
    companyId: string,
    roleCode: string,
    option?: TxOption,
  ): Promise<string[]> {
    const client = option?.prisma ?? this.prisma;

    const rows = await client.userRole.findMany({
      where: { companyId, role: { code: roleCode } },
      orderBy: { grantedAt: 'asc' },
      select: { userId: true },
    });

    return rows.map((row) => row.userId);
  }

  /**
   * Who holds one role in one company, for screen A4.
   *
   * Ordered so hand-bound grants surface first: they are the ones an admin can
   * act on here, and the ones that carry a "รักษาการ" story worth reviewing —
   * a Keycloak-mapped grant is changed in Keycloak, not on this screen.
   */
  async holdersOfRoleId(
    roleId: string,
    companyId: string,
    option?: TxOption,
  ): Promise<RoleHolder[]> {
    const client = option?.prisma ?? this.prisma;

    const rows = await client.userRole.findMany({
      where: { roleId, companyId },
      orderBy: [{ source: 'asc' }, { grantedAt: 'asc' }],
      select: {
        userId: true,
        source: true,
        grantedAt: true,
        user: { select: { username: true, displayName: true } },
        grantedBy: { select: { displayName: true } },
      },
    });

    return rows.map((row) => ({
      userId: row.userId,
      username: row.user.username,
      displayName: row.user.displayName,
      source: row.source,
      grantedAt: row.grantedAt,
      grantedByDisplayName: row.grantedBy?.displayName ?? null,
    }));
  }

  grant(
    input: {
      userId: string;
      roleId: string;
      companyId: string;
      source?: 'KEYCLOAK_MAPPING' | 'MANUAL';
      grantedByUserId?: string;
    },
    option?: TxOption,
  ): Promise<UserRole> {
    const { userId, roleId, companyId } = input;

    return this.upsert(
      {
        where: { userId_roleId_companyId: { userId, roleId, companyId } },
        update: {},
        create: {
          userId,
          roleId,
          companyId,
          source: input.source ?? 'MANUAL',
          grantedByUserId: input.grantedByUserId,
        },
      },
      option,
    );
  }

  async revoke(
    userId: string,
    roleId: string,
    companyId: string,
    option?: TxOption,
  ): Promise<void> {
    const client = option?.prisma ?? this.prisma;
    await client.userRole.deleteMany({ where: { userId, roleId, companyId } });
  }
}
