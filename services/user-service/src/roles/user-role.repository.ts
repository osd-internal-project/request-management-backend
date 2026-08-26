import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
  TxOption,
} from '@request-management/share';
import type { Role, RolePermission, UserRole } from '@prisma/client';

export type UserRoleWithRole = UserRole & {
  role: Role & { permissions: RolePermission[] };
};

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

  /**
   * ROLE-03: replaces the Keycloak-derived grants for one company, leaving
   * manually bound roles untouched. Revoking a role in Keycloak therefore
   * revokes it here on the next login, while an admin's manual grant survives.
   */
  async replaceMappedRoles(
    userId: string,
    companyId: string,
    roleIds: readonly string[],
    option?: TxOption,
  ): Promise<{ added: string[]; removed: string[] }> {
    const client = option?.prisma ?? this.prisma;

    const existing = await client.userRole.findMany({
      where: { userId, companyId, source: 'KEYCLOAK_MAPPING' },
      select: { roleId: true },
    });
    const existingIds = existing.map((row) => row.roleId);

    const removed = existingIds.filter((id) => !roleIds.includes(id));
    const added = roleIds.filter((id) => !existingIds.includes(id));

    if (removed.length) {
      await client.userRole.deleteMany({
        where: {
          userId,
          companyId,
          source: 'KEYCLOAK_MAPPING',
          roleId: { in: removed },
        },
      });
    }

    for (const roleId of added) {
      await client.userRole.upsert({
        where: { userId_roleId_companyId: { userId, roleId, companyId } },
        update: {},
        create: { userId, roleId, companyId, source: 'KEYCLOAK_MAPPING' },
      });
    }

    return { added, removed };
  }
}
