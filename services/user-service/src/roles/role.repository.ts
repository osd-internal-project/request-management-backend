import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
  TxOption,
} from '@request-management/share';
import type { Prisma, Role, RolePermission } from '@prisma/client';

export type RoleWithPermissions = Role & { permissions: RolePermission[] };

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
  ): Promise<RoleWithPermissions[]> {
    return this.findMany(
      {
        where: { OR: [{ companyId }, { companyId: null }] },
        include: { permissions: true },
        orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
      },
      option,
    ) as Promise<RoleWithPermissions[]>;
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
