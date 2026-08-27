import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
  TxOption,
} from '@request-management/share';
import type { Prisma, Role, RolePermission } from '@prisma/client';

export type RoleWithPermissions = Role & { permissions: RolePermission[] };

/**
 * A role plus how many people hold it **in the company being viewed**.
 *
 * Screen A4 leads with that number and uses it to explain why a role cannot be
 * deleted, so it has to be the count for the active company — `UserRole` is
 * bound per company (ROLE-04), and a group-wide role template would otherwise
 * report everyone who holds it anywhere.
 */
export type RoleWithHolderCount = RoleWithPermissions & {
  _count: { users: number };
};

@Injectable()
export class RoleRepository extends BaseRepository<PrismaService['role']> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.role;
  }

  findById(id: string, option?: TxOption): Promise<RoleWithPermissions | null> {
    return this.findUnique(
      { where: { id }, include: { permissions: true } },
      option,
    ) as Promise<RoleWithPermissions | null>;
  }

  /** Roles usable in a company: its own plus group-wide templates. */
  findForCompany(
    companyId: string,
    option?: TxOption,
  ): Promise<RoleWithHolderCount[]> {
    return this.findMany(
      {
        where: { OR: [{ companyId }, { companyId: null }] },
        include: {
          permissions: true,
          // Counted in the same query rather than one `count` per role: the
          // list is small today, but a per-row count is the shape that turns
          // into an N+1 as soon as it is not.
          _count: { select: { users: { where: { companyId } } } },
        },
        orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
      },
      option,
    ) as Promise<RoleWithHolderCount[]>;
  }

  /**
   * Goes through the client rather than `BaseRepository.create` because the
   * base CRUD signatures cannot express an `include` — the same reason
   * `updateRole` below does.
   */
  createRole(
    data: Prisma.RoleUncheckedCreateInput,
    permissions: readonly string[],
    option?: TxOption,
  ): Promise<RoleWithPermissions> {
    const client = option?.prisma ?? this.prisma;

    return client.role.create({
      data: {
        ...data,
        permissions: {
          create: permissions.map((permissionCode) => ({ permissionCode })),
        },
      },
      include: { permissions: true },
    });
  }

  /** Replaces the permission set wholesale — simpler to reason about than a diff. */
  async updateRole(
    id: string,
    data: Prisma.RoleUncheckedUpdateInput,
    permissions: readonly string[] | undefined,
    option?: TxOption,
  ): Promise<RoleWithPermissions> {
    const client = option?.prisma ?? this.prisma;

    if (permissions) {
      await client.rolePermission.deleteMany({ where: { roleId: id } });
      await client.rolePermission.createMany({
        data: permissions.map((permissionCode) => ({
          roleId: id,
          permissionCode,
        })),
      });
    }

    return client.role.update({
      where: { id },
      data,
      include: { permissions: true },
    });
  }

  countUsers(roleId: string, option?: TxOption): Promise<number> {
    const client = option?.prisma ?? this.prisma;
    return client.userRole.count({ where: { roleId } });
  }
}
