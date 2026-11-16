import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  COMPANY_ADMIN_ROLE_CODE,
  PrismaService,
  TQueryClient,
  TxOption,
} from '@request-management/share';
import type { Prisma, UserStatus } from '@prisma/client';

/** What `/system/users` shows of a person: every company, not the active one. */
const SYSTEM_USER_SELECT = {
  id: true,
  username: true,
  displayName: true,
  email: true,
  status: true,
  suspendedAt: true,
  suspendedBy: true,
  suspendReason: true,
  primaryCompanyId: true,
  companies: {
    select: {
      isPrimary: true,
      company: { select: { id: true, code: true, name: true, active: true } },
    },
  },
  systemRoles: {
    select: { role: { select: { id: true, code: true, name: true } } },
  },
} satisfies Prisma.UserSelect;

export type SystemUserRow = Prisma.UserGetPayload<{
  select: typeof SYSTEM_USER_SELECT;
}>;

export interface SystemUserFilter {
  q?: string;
  status?: UserStatus;
  companyId?: string;
}

/**
 * Reads across companies on purpose — the system plane is the one place that
 * may (P5). Every query starts from `User`/`Company`/`Role(companyId null)`,
 * never from a company-scoped table without its `companyId`.
 */
@Injectable()
export class SystemRepository extends BaseRepository<PrismaService['user']> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.user;
  }

  private whereOf(filter: SystemUserFilter): Prisma.UserWhereInput {
    const q = filter.q?.trim();
    return {
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.companyId
        ? { companies: { some: { companyId: filter.companyId } } }
        : {}),
      ...(q
        ? {
            OR: [
              { username: { contains: q, mode: 'insensitive' } },
              { displayName: { contains: q, mode: 'insensitive' } },
              { email: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
  }

  async searchUsers(
    filter: SystemUserFilter,
    page: { skip: number; take: number },
  ): Promise<{ rows: SystemUserRow[]; total: number }> {
    const where = this.whereOf(filter);
    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: SYSTEM_USER_SELECT,
        orderBy: { displayName: 'asc' },
        ...page,
      }),
      this.prisma.user.count({ where }),
    ]);
    return { rows, total };
  }

  findUser(id: string, option?: TxOption): Promise<SystemUserRow | null> {
    const client = option?.prisma ?? this.prisma;
    return client.user.findUnique({
      where: { id },
      select: SYSTEM_USER_SELECT,
    });
  }

  setStatus(
    id: string,
    data: Pick<
      Prisma.UserUncheckedUpdateInput,
      'status' | 'suspendedAt' | 'suspendedBy' | 'suspendReason'
    >,
    option?: TxOption,
  ) {
    const client = option?.prisma ?? this.prisma;
    return client.user.update({ where: { id }, data, select: { id: true } });
  }

  setPrimaryCompany(id: string, companyId: string | null, option?: TxOption) {
    const client = option?.prisma ?? this.prisma;
    return client.user.update({
      where: { id },
      data: { primaryCompanyId: companyId },
      select: { id: true },
    });
  }

  listCompanies() {
    return this.prisma.company.findMany({
      orderBy: { code: 'asc' },
      select: {
        id: true,
        code: true,
        name: true,
        docPrefix: true,
        baseCurrency: true,
        active: true,
        createdAt: true,
        _count: { select: { users: true, orgUnits: true } },
      },
    });
  }

  /** สมาชิกที่บัญชีถูกปิด ต่อบริษัท — ตัวเลขระดับองค์กร ไม่แตะข้อมูลงาน */
  suspendedMembersByCompany() {
    return this.prisma.userCompany.groupBy({
      by: ['companyId'],
      // ระดับระบบ: ทุกบริษัทโดยตั้งใจ — key ต้องมีให้ tenant guard เห็นว่าเลือกแล้ว
      where: { companyId: undefined, user: { status: 'SUSPENDED' } },
      _count: { _all: true },
    });
  }

  /** ผู้ถือ role ผู้ดูแลของแต่ละบริษัท */
  adminHolders(companyId?: string) {
    return this.prisma.userRole.findMany({
      where: {
        role: { code: COMPANY_ADMIN_ROLE_CODE, level: 'COMPANY' },
        // undefined = ทุกบริษัท (ภาพรวมระบบ); key ต้องมีให้ tenant guard เห็นว่าเลือกแล้ว
        companyId,
      },
      select: {
        companyId: true,
        user: {
          select: { id: true, displayName: true, email: true, status: true },
        },
      },
    });
  }

  findCompanyRole(companyId: string, code: string, option?: TxOption) {
    const client = option?.prisma ?? this.prisma;
    return client.role.findUnique({
      where: { companyId_code: { companyId, code } },
      select: { id: true },
    });
  }

  /** ตั้งต้นบริษัทใหม่: role ผู้ดูแล + หน่วยงานราก (ภายใน transaction ของผู้เรียก) */
  async bootstrapCompany(
    company: { id: string; code: string; name: string },
    permissions: readonly string[],
    actorId: string,
    option: TxOption,
  ) {
    const client = option.prisma ?? this.prisma;
    const role = await client.role.create({
      data: {
        companyId: company.id,
        code: COMPANY_ADMIN_ROLE_CODE,
        name: 'ผู้ดูแลระบบ',
        description: 'ทีมที่ดูแลการตั้งค่า — ไม่มีสิทธิ์อนุมัติแทนใคร',
        isSystem: true,
        level: 'COMPANY',
        createdBy: actorId,
        permissions: {
          create: permissions.map((permissionCode) => ({ permissionCode })),
        },
      },
      select: { id: true },
    });
    const root = await client.orgUnit.create({
      data: {
        companyId: company.id,
        code: company.code,
        name: company.name,
        kind: 'COMPANY',
      },
      select: { id: true },
    });
    return { roleId: role.id, rootUnitId: root.id };
  }

  /** ให้คนหนึ่งเป็นผู้ดูแลบริษัท: สมาชิก + role (MANUAL) — ไม่แตะบริษัทหลักของเขา */
  async addCompanyAdmin(
    userId: string,
    companyId: string,
    roleId: string,
    grantedBy: string,
    option: TxOption,
  ) {
    const client = option.prisma ?? this.prisma;
    await client.userCompany.upsert({
      where: { userId_companyId: { userId, companyId } },
      update: {},
      create: { userId, companyId, isPrimary: false },
    });
    await client.userRole.upsert({
      where: { userId_roleId_companyId: { userId, roleId, companyId } },
      update: {},
      create: {
        userId,
        roleId,
        companyId,
        source: 'MANUAL',
        grantedByUserId: grantedBy,
      },
    });
  }

  findCompaniesByIds(ids: readonly string[], option?: TxOption) {
    const client = option?.prisma ?? this.prisma;
    return client.company.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true },
    });
  }

  findCompany(id: string, option?: TxOption) {
    const client = option?.prisma ?? this.prisma;
    return client.company.findUnique({ where: { id } });
  }

  findCompanyByCode(code: string, option?: TxOption) {
    const client = option?.prisma ?? this.prisma;
    return client.company.findUnique({ where: { code } });
  }

  createCompany(data: Prisma.CompanyCreateInput, option?: TxOption) {
    const client = option?.prisma ?? this.prisma;
    return client.company.create({ data });
  }

  updateCompany(
    id: string,
    data: Prisma.CompanyUpdateInput,
    option?: TxOption,
  ) {
    const client = option?.prisma ?? this.prisma;
    return client.company.update({ where: { id }, data });
  }

  /** Roles no company owns: templates (COMPANY) and system roles (SYSTEM). */
  listSharedRoles() {
    return this.prisma.role.findMany({
      where: { companyId: null },
      include: {
        permissions: true,
        _count: { select: { users: true, systemUsers: true } },
      },
      orderBy: [{ level: 'desc' }, { name: 'asc' }],
    });
  }

  findSharedRole(id: string, option?: TxOption) {
    const client = option?.prisma ?? this.prisma;
    return client.role.findFirst({
      where: { id, companyId: null },
      include: { permissions: true },
    });
  }

  findSharedRoleByCode(code: string, option?: TxOption) {
    const client = option?.prisma ?? this.prisma;
    return client.role.findFirst({
      where: { companyId: null, code },
      select: { id: true },
    });
  }

  systemRoleHolders(roleId: string) {
    return this.prisma.systemUserRole.findMany({
      where: { roleId },
      select: {
        grantedAt: true,
        user: {
          select: { id: true, username: true, displayName: true, status: true },
        },
      },
      orderBy: { grantedAt: 'asc' },
    });
  }

  grantSystemRole(
    data: { userId: string; roleId: string; grantedByUserId: string },
    option?: TxOption,
  ) {
    const client = option?.prisma ?? this.prisma;
    return client.systemUserRole.upsert({
      where: { userId_roleId: { userId: data.userId, roleId: data.roleId } },
      update: {},
      create: data,
    });
  }

  revokeSystemRole(userId: string, roleId: string, option?: TxOption) {
    const client = option?.prisma ?? this.prisma;
    return client.systemUserRole.deleteMany({ where: { userId, roleId } });
  }

  /**
   * Active people still able to manage system roles once `except` is gone —
   * one grant (both given), every grant of a person (suspending), or every
   * holder of a role (switching it off).
   */
  countRoleManagers(
    except: { userId?: string; roleId?: string },
    option?: TxOption,
  ): Promise<number> {
    const client = option?.prisma ?? this.prisma;
    return client.systemUserRole.count({
      where: {
        NOT: { userId: except.userId, roleId: except.roleId },
        user: { status: 'ACTIVE' },
        role: {
          level: 'SYSTEM',
          active: true,
          permissions: { some: { permissionCode: 'system.role.manage' } },
        },
      },
    });
  }
}
