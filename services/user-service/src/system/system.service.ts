import { Injectable } from '@nestjs/common';
import {
  AppError,
  assertHumanPermissions,
  assertPermissionsFitLevel,
  assertSeparationOfDuties,
  paginated,
  Principal,
  PrismaTransactionService,
  toSkipTake,
  TxOption,
} from '@request-management/share';
import { AuditService } from '../audit/audit.service';
import { AuditEvent } from '../audit/audit-events';
import { UserCompanyRepository } from '../org/user-company.repository';
import { RoleRepository } from '../roles/role.repository';
import { RolesService } from '../roles/roles.service';
import {
  CreateCompanyDto,
  CreateSharedRoleDto,
  ReplaceUserCompaniesDto,
  SearchSystemUsersDto,
  SuspendUserDto,
  UpdateCompanyDto,
  UpdateSharedRoleDto,
} from './dto/system.dto';
import { SystemRepository } from './system.repository';

/**
 * P5 system plane: people, companies and shared roles across every company.
 * Audit rows carry `companyId` null unless the change lands in one company.
 */
@Injectable()
export class SystemService {
  constructor(
    private readonly system: SystemRepository,
    private readonly roles: RoleRepository,
    private readonly rolesService: RolesService,
    private readonly memberships: UserCompanyRepository,
    private readonly audit: AuditService,
    private readonly transactions: PrismaTransactionService,
  ) {}

  private actorOf(actor: Principal) {
    return { actorId: actor.userId, actorUsername: actor.username };
  }

  async searchUsers(query: SearchSystemUsersDto) {
    const { rows, total } = await this.system.searchUsers(
      { q: query.q, status: query.status, companyId: query.company_id },
      toSkipTake(query),
    );
    return paginated(rows, query, total);
  }

  private async requireUser(id: string, option?: TxOption) {
    const user = await this.system.findUser(id, option);
    if (!user) throw new AppError('NOT_FOUND', 'ไม่พบผู้ใช้ที่ระบุ');
    return user;
  }

  /** Only the system plane may suspend (Q6); a company admin can only remove from their company. */
  async suspend(id: string, dto: SuspendUserDto, actor: Principal) {
    if (id === actor.userId) {
      throw new AppError('UNPROCESSABLE', 'ปิดบัญชีของตัวเองไม่ได้');
    }
    return this.transactions.execute(async (prisma) => {
      const option = { prisma };
      const user = await this.requireUser(id, option);
      if (user.status === 'SUSPENDED') return this.system.findUser(id, option);

      if (user.systemRoles.length) {
        const left = await this.system.countRoleManagers(
          { userId: id },
          option,
        );
        if (left === 0) {
          throw new AppError(
            'UNPROCESSABLE',
            'ต้องเหลือผู้ดูแลระบบที่จัดการ role ระบบได้อย่างน้อย 1 คน',
          );
        }
      }

      const reason = dto.reason.trim();
      await this.system.setStatus(
        id,
        {
          status: 'SUSPENDED',
          suspendedAt: new Date(),
          suspendedBy: actor.userId,
          suspendReason: reason,
        },
        option,
      );
      await this.audit.record(
        {
          eventType: AuditEvent.SYSTEM_USER_SUSPENDED,
          ...this.actorOf(actor),
          resourceType: 'user',
          resourceId: id,
          before: { status: user.status },
          after: { status: 'SUSPENDED', reason },
        },
        option,
      );
      return this.system.findUser(id, option);
    });
  }

  async reactivate(id: string, actor: Principal) {
    return this.transactions.execute(async (prisma) => {
      const option = { prisma };
      const user = await this.requireUser(id, option);
      if (user.status === 'ACTIVE') return user;

      await this.system.setStatus(
        id,
        {
          status: 'ACTIVE',
          suspendedAt: null,
          suspendedBy: null,
          suspendReason: null,
        },
        option,
      );
      await this.audit.record(
        {
          eventType: AuditEvent.SYSTEM_USER_REACTIVATED,
          ...this.actorOf(actor),
          resourceType: 'user',
          resourceId: id,
          before: { status: user.status, reason: user.suspendReason },
          after: { status: 'ACTIVE' },
        },
        option,
      );
      return this.system.findUser(id, option);
    });
  }

  /**
   * Moves a person between companies. A company dropped from the list loses
   * its role grants and placement with it (`detachFromCompany`).
   */
  async replaceCompanies(
    id: string,
    dto: ReplaceUserCompaniesDto,
    actor: Principal,
  ) {
    const wanted = [...new Set(dto.company_ids)];
    const primary = dto.primary_company_id ?? wanted[0] ?? null;
    if (primary && !wanted.includes(primary)) {
      throw new AppError(
        'VALIDATION_FAILED',
        'บริษัทหลักต้องอยู่ในรายการบริษัท',
        [{ field: 'primary_company_id', reason: 'not_in_company_ids' }],
      );
    }

    return this.transactions.execute(async (prisma) => {
      const option = { prisma };
      const user = await this.requireUser(id, option);

      const found = await this.system.findCompaniesByIds(wanted, option);
      if (found.length !== wanted.length) {
        throw new AppError('NOT_FOUND', 'ไม่พบบริษัทที่ระบุ', [
          { field: 'company_ids', reason: 'unknown_company' },
        ]);
      }

      const before = user.companies.map((row) => row.company.id);
      for (const companyId of before.filter((c) => !wanted.includes(c))) {
        await this.memberships.detachFromCompany(id, companyId, option);
      }
      await this.memberships.replaceForUser(id, wanted, primary, option);
      await this.system.setPrimaryCompany(id, primary, option);

      await this.audit.record(
        {
          eventType: AuditEvent.SYSTEM_USER_COMPANIES_REPLACED,
          ...this.actorOf(actor),
          resourceType: 'user',
          resourceId: id,
          before: {
            companyIds: before,
            primaryCompanyId: user.primaryCompanyId,
          },
          after: { companyIds: wanted, primaryCompanyId: primary },
        },
        option,
      );
      return this.system.findUser(id, option);
    });
  }

  /**
   * A company role (its own or a template) for a person in any company — what
   * makes a company the system plane just created usable by someone.
   */
  grantCompanyRole(
    userId: string,
    companyId: string,
    roleId: string,
    actor: Principal,
  ) {
    return this.rolesService.grantRole(userId, roleId, companyId, actor);
  }

  revokeCompanyRole(
    userId: string,
    companyId: string,
    roleId: string,
    actor: Principal,
  ) {
    return this.rolesService.revokeRole(userId, roleId, companyId, actor);
  }

  listCompanies() {
    return this.system.listCompanies();
  }

  async createCompany(dto: CreateCompanyDto, actor: Principal) {
    return this.transactions.execute(async (prisma) => {
      const option = { prisma };
      if (await this.system.findCompanyByCode(dto.code, option)) {
        throw new AppError('CONFLICT', `รหัสบริษัท ${dto.code} มีอยู่แล้ว`, [
          { field: 'code', reason: 'taken' },
        ]);
      }
      const company = await this.system.createCompany(
        { code: dto.code, name: dto.name.trim(), docPrefix: dto.doc_prefix },
        option,
      );
      await this.audit.record(
        {
          eventType: AuditEvent.SYSTEM_COMPANY_CREATED,
          companyId: company.id,
          ...this.actorOf(actor),
          resourceType: 'company',
          resourceId: company.id,
          after: { code: company.code, name: company.name },
        },
        option,
      );
      return company;
    });
  }

  /** Closing a company is `active = false`; rows stay (no hard deletes). */
  async updateCompany(id: string, dto: UpdateCompanyDto, actor: Principal) {
    return this.transactions.execute(async (prisma) => {
      const option = { prisma };
      const before = await this.system.findCompany(id, option);
      if (!before) throw new AppError('NOT_FOUND', 'ไม่พบบริษัทที่ระบุ');

      const after = await this.system.updateCompany(
        id,
        {
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.active !== undefined ? { active: dto.active } : {}),
        },
        option,
      );
      await this.audit.record(
        {
          eventType: AuditEvent.SYSTEM_COMPANY_UPDATED,
          companyId: id,
          ...this.actorOf(actor),
          resourceType: 'company',
          resourceId: id,
          before: { name: before.name, active: before.active },
          after: { name: after.name, active: after.active },
        },
        option,
      );
      return after;
    });
  }

  listPermissions() {
    return this.rolesService.listPermissions();
  }

  listSharedRoles() {
    return this.system.listSharedRoles();
  }

  private assertRolePermissions(
    level: 'COMPANY' | 'SYSTEM',
    permissions: readonly string[],
  ) {
    assertPermissionsFitLevel(level, permissions);
    if (level === 'COMPANY') {
      assertSeparationOfDuties(permissions);
      assertHumanPermissions(permissions);
    }
  }

  async createSharedRole(dto: CreateSharedRoleDto, actor: Principal) {
    this.assertRolePermissions(dto.level, dto.permissions);

    return this.transactions.execute(async (prisma) => {
      const option = { prisma };
      if (await this.system.findSharedRoleByCode(dto.code, option)) {
        throw new AppError('CONFLICT', `รหัส role ${dto.code} มีอยู่แล้ว`, [
          { field: 'code', reason: 'taken' },
        ]);
      }

      const role = await this.roles.createRole(
        {
          companyId: null,
          level: dto.level,
          code: dto.code,
          name: dto.name,
          description: dto.description,
          // A system role reads nothing of a company's chart.
          visibilityLevel:
            dto.level === 'COMPANY' ? (dto.visibility_level ?? null) : null,
          createdBy: actor.userId,
          updatedBy: actor.userId,
        },
        dto.permissions,
        option,
      );
      await this.audit.record(
        {
          eventType: AuditEvent.ROLE_CREATED,
          ...this.actorOf(actor),
          resourceType: 'role',
          resourceId: role.id,
          after: {
            code: role.code,
            level: role.level,
            permissions: dto.permissions,
          },
        },
        option,
      );
      return role;
    });
  }

  async updateSharedRole(
    id: string,
    dto: UpdateSharedRoleDto,
    actor: Principal,
  ) {
    return this.transactions.execute(async (prisma) => {
      const option = { prisma };
      const before = await this.system.findSharedRole(id, option);
      if (!before) throw new AppError('NOT_FOUND', 'ไม่พบบทบาทที่ระบุ');
      if (dto.permissions) {
        this.assertRolePermissions(before.level, dto.permissions);
      }

      const after = await this.roles.updateRole(
        id,
        {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.description !== undefined
            ? { description: dto.description }
            : {}),
          ...(dto.active !== undefined ? { active: dto.active } : {}),
          ...('visibility_level' in dto && before.level === 'COMPANY'
            ? { visibilityLevel: dto.visibility_level ?? null }
            : {}),
          updatedBy: actor.userId,
        },
        dto.permissions,
        option,
      );

      // Switching off or stripping the last role that manages system roles locks everyone out.
      const stillManages =
        after.active &&
        after.permissions.some(
          (p) => p.permissionCode === 'system.role.manage',
        );
      if (before.level === 'SYSTEM' && !stillManages) {
        const others = await this.system.countRoleManagers(
          { roleId: id },
          option,
        );
        if (others === 0) {
          throw new AppError(
            'UNPROCESSABLE',
            'ต้องเหลือผู้ดูแลระบบที่จัดการ role ระบบได้อย่างน้อย 1 คน',
          );
        }
      }

      await this.audit.record(
        {
          eventType:
            dto.active === false
              ? AuditEvent.ROLE_DEACTIVATED
              : AuditEvent.ROLE_UPDATED,
          ...this.actorOf(actor),
          resourceType: 'role',
          resourceId: id,
          before: {
            name: before.name,
            active: before.active,
            permissions: before.permissions.map((p) => p.permissionCode),
          },
          after: {
            name: after.name,
            active: after.active,
            permissions: after.permissions.map((p) => p.permissionCode),
          },
        },
        option,
      );
      return after;
    });
  }

  async systemRoleHolders(roleId: string) {
    const role = await this.system.findSharedRole(roleId);
    if (!role || role.level !== 'SYSTEM') {
      throw new AppError('NOT_FOUND', 'ไม่พบบทบาทที่ระบุ');
    }
    return this.system.systemRoleHolders(roleId);
  }

  async grantSystemRole(userId: string, roleId: string, actor: Principal) {
    return this.transactions.execute(async (prisma) => {
      const option = { prisma };
      await this.requireUser(userId, option);
      const role = await this.system.findSharedRole(roleId, option);
      if (!role || role.level !== 'SYSTEM' || !role.active) {
        throw new AppError('NOT_FOUND', 'ไม่พบบทบาทระบบที่ใช้งานอยู่');
      }
      await this.system.grantSystemRole(
        { userId, roleId, grantedByUserId: actor.userId },
        option,
      );
      await this.audit.record(
        {
          eventType: AuditEvent.SYSTEM_ROLE_GRANTED,
          ...this.actorOf(actor),
          resourceType: 'user',
          resourceId: userId,
          after: { roleId, roleCode: role.code },
        },
        option,
      );
    });
  }

  async revokeSystemRole(userId: string, roleId: string, actor: Principal) {
    return this.transactions.execute(async (prisma) => {
      const option = { prisma };
      const role = await this.system.findSharedRole(roleId, option);
      if (!role || role.level !== 'SYSTEM') {
        throw new AppError('NOT_FOUND', 'ไม่พบบทบาทที่ระบุ');
      }
      const left = await this.system.countRoleManagers(
        { userId, roleId },
        option,
      );
      if (left === 0) {
        throw new AppError(
          'UNPROCESSABLE',
          'ต้องเหลือผู้ดูแลระบบที่จัดการ role ระบบได้อย่างน้อย 1 คน',
        );
      }
      const { count } = await this.system.revokeSystemRole(
        userId,
        roleId,
        option,
      );
      if (!count) throw new AppError('NOT_FOUND', 'ผู้ใช้ไม่ได้ถือบทบาทนี้');

      await this.audit.record(
        {
          eventType: AuditEvent.SYSTEM_ROLE_REVOKED,
          ...this.actorOf(actor),
          resourceType: 'user',
          resourceId: userId,
          before: { roleId, roleCode: role.code },
        },
        option,
      );
    });
  }
}
