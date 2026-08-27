import { Injectable } from '@nestjs/common';
import {
  AppError,
  PrismaTransactionService,
  TxOption,
} from '@request-management/share';
import type { Principal, ScopeLevel } from '@request-management/share';
import type { Company, OrgUnit, User } from '@prisma/client';
import { PolicyService } from '../policy/policy.service';
import { RolesService } from '../roles/roles.service';
import { AuditService } from '../audit/audit.service';
import { AuditEvent } from '../audit/audit-events';
import { UsersRepository } from '../users/users.repository';
import { CompanyRepository } from './company.repository';
import { OrgClosureRepository } from './org-closure.repository';
import { OrgUnitRepository } from './org-unit.repository';
import {
  MembershipWithCompany,
  UserCompanyRepository,
} from './user-company.repository';
import {
  AssignUserOrgDto,
  CreateOrgUnitDto,
  UpdateOrgUnitDto,
} from './dto/org-unit.dto';

/** The org-unit id sets a principal needs for scope resolution. */
export interface ScopeSets {
  teamOrgUnitIds: string[];
  departmentOrgUnitIds: string[];
}

/** One node of the A3 tree. */
export interface OrgUnitNode {
  id: string;
  code: string;
  name: string;
  kind: OrgUnit['kind'];
  parentId: string | null;
  active: boolean;
  managerUserId: string | null;
  managerDisplayName: string | null;
  memberCount: number;
}

/** One row of the A3 member panel. */
export interface OrgMember {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  /**
   * System roles bound in this company. `id` is needed because scope is
   * configured per (role, resource) — SCOPE-01 — so editing a member's scope
   * means editing their role's scope rule.
   */
  roles: { id: string; code: string; name: string; source: string }[];
  scope: ScopeLevel;
  supervisor: { id: string; displayName: string } | null;
  /**
   * Realm roles from the last login. Per the A3 mockup this is the member's
   * **primary** role — "role หลักมาจาก Keycloak" — while scope is what an
   * admin adjusts in this system.
   */
  keycloakRoles: string[];
}

@Injectable()
export class OrgService {
  constructor(
    private readonly companies: CompanyRepository,
    private readonly orgUnits: OrgUnitRepository,
    private readonly closure: OrgClosureRepository,
    private readonly memberships: UserCompanyRepository,
    private readonly users: UsersRepository,
    private readonly roles: RolesService,
    private readonly policy: PolicyService,
    private readonly audit: AuditService,
    private readonly transactions: PrismaTransactionService,
  ) {}

  listUnits(companyId: string): Promise<OrgUnit[]> {
    return this.orgUnits.findForCompany(companyId);
  }

  /** The A3 tree: each node with its manager's name and direct member count. */
  async listUnitsWithDetail(companyId: string): Promise<OrgUnitNode[]> {
    const units = await this.orgUnits.findForCompanyWithDetail(companyId);

    return units.map((unit) => ({
      id: unit.id,
      code: unit.code,
      name: unit.name,
      kind: unit.kind,
      parentId: unit.parentId,
      active: unit.active,
      managerUserId: unit.managerUserId,
      managerDisplayName: unit.manager?.displayName ?? null,
      memberCount: unit._count.members,
    }));
  }

  /**
   * Members of one unit with the system role, data scope, and supervisor that
   * screen A3 prints beside each name.
   *
   * Role and scope come from `RolesService` and `PolicyService` — the same
   * resolution the guards use — rather than a second query that could drift
   * from what the system actually enforces.
   */
  async listMembers(
    orgUnitId: string,
    companyId: string,
  ): Promise<OrgMember[]> {
    const members = await this.users.findMembersOf(orgUnitId);

    return Promise.all(
      members.map(async (member) => {
        const userRoles = await this.roles.rolesForUser(member.id, companyId);
        const roleIds = userRoles.map((userRole) => userRole.roleId);
        const scopes = await this.policy.resolveScopes(roleIds);

        return {
          id: member.id,
          username: member.username,
          displayName: member.displayName,
          email: member.email,
          roles: userRoles.map((userRole) => ({
            id: userRole.role.id,
            code: userRole.role.code,
            name: userRole.role.name,
            source: userRole.source,
          })),
          // The resource A3 labels "scope:" is the request scope.
          scope: scopes.request ?? 'own',
          supervisor: member.supervisor,
          keycloakRoles: member.keycloakRoles,
        };
      }),
    );
  }

  /** AUTH-04: the "รอจัดสังกัด" queue shown on admin screen A3. */
  listUnassignedUsers(): Promise<User[]> {
    return this.users.findUnassigned();
  }

  companiesForUser(userId: string): Promise<MembershipWithCompany[]> {
    return this.memberships.findForUser(userId);
  }

  findCompany(id: string): Promise<Company | null> {
    return this.companies.findById(id);
  }

  async createUnit(dto: CreateOrgUnitDto, actor: Principal): Promise<OrgUnit> {
    return this.transactions.execute(async (prisma) => {
      const option = { prisma };

      if (dto.parent_id) {
        await this.requireSameCompany(dto.parent_id, dto.company_id, option);
      }

      const unit = await this.orgUnits.createUnit(
        {
          companyId: dto.company_id,
          code: dto.code,
          name: dto.name,
          kind: dto.kind ?? 'TEAM',
          parentId: dto.parent_id ?? null,
          managerUserId: dto.manager_user_id ?? null,
          createdBy: actor.userId,
          updatedBy: actor.userId,
        },
        option,
      );

      await this.rebuildClosure(dto.company_id, option);
      await this.audit.record(
        {
          eventType: AuditEvent.ORG_UNIT_CREATED,
          companyId: dto.company_id,
          actorId: actor.userId,
          actorUsername: actor.username,
          resourceType: 'org_unit',
          resourceId: unit.id,
          after: unit,
        },
        option,
      );

      return unit;
    });
  }

  async updateUnit(
    id: string,
    dto: UpdateOrgUnitDto,
    actor: Principal,
  ): Promise<OrgUnit> {
    return this.transactions.execute(async (prisma) => {
      const option = { prisma };

      const before = await this.orgUnits.findById(id, option);
      if (!before) {
        throw new AppError('NOT_FOUND', 'ไม่พบหน่วยงานที่ระบุ');
      }

      if (dto.parent_id !== undefined && dto.parent_id !== before.parentId) {
        await this.assertNoCycle(id, dto.parent_id, before.companyId, option);
      }

      const after = await this.orgUnits.updateUnit(
        id,
        {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.kind !== undefined ? { kind: dto.kind } : {}),
          ...(dto.parent_id !== undefined ? { parentId: dto.parent_id } : {}),
          ...(dto.manager_user_id !== undefined
            ? { managerUserId: dto.manager_user_id }
            : {}),
          ...(dto.active !== undefined ? { active: dto.active } : {}),
          updatedBy: actor.userId,
        },
        option,
      );

      // Re-parenting changes who is under whom, which changes what every
      // manager in the subtree can see. The closure has to move with it, in
      // the same transaction, or scope answers go stale mid-request.
      if (dto.parent_id !== undefined) {
        await this.rebuildClosure(before.companyId, option);
      }

      await this.audit.record(
        {
          eventType: AuditEvent.ORG_UNIT_UPDATED,
          companyId: before.companyId,
          actorId: actor.userId,
          actorUsername: actor.username,
          resourceType: 'org_unit',
          resourceId: id,
          before,
          after,
        },
        option,
      );

      return after;
    });
  }

  /** §11.2 `PATCH /admin/users/{id}/org`. */
  async assignUser(
    userId: string,
    dto: AssignUserOrgDto,
    actor: Principal,
  ): Promise<User> {
    return this.transactions.execute(async (prisma) => {
      const option = { prisma };

      const before = await this.users.findById(userId, option);
      if (!before) {
        throw new AppError('NOT_FOUND', 'ไม่พบผู้ใช้ที่ระบุ');
      }

      if (dto.companies?.length) {
        const primary =
          dto.primary_company_id ??
          (dto.companies.includes(before.primaryCompanyId ?? '')
            ? before.primaryCompanyId
            : dto.companies[0]);

        await this.memberships.replaceForUser(
          userId,
          dto.companies,
          primary ?? null,
          option,
        );
      }

      const after = await this.users.assignOrg(
        userId,
        {
          ...(dto.org_unit_id !== undefined
            ? { orgUnitId: dto.org_unit_id }
            : {}),
          ...(dto.supervisor_user_id !== undefined
            ? { supervisorUserId: dto.supervisor_user_id }
            : {}),
          ...(dto.primary_company_id
            ? { primaryCompanyId: dto.primary_company_id }
            : {}),
        },
        option,
      );

      await this.audit.record(
        {
          eventType: AuditEvent.ORG_USER_ASSIGNED,
          companyId: after.primaryCompanyId,
          actorId: actor.userId,
          actorUsername: actor.username,
          resourceType: 'user',
          resourceId: userId,
          before: {
            orgUnitId: before.orgUnitId,
            supervisorUserId: before.supervisorUserId,
          },
          after: {
            orgUnitId: after.orgUnitId,
            supervisorUserId: after.supervisorUserId,
          },
        },
        option,
      );

      return after;
    });
  }

  /**
   * The id sets `buildScopeWhere` needs: the caller's own subtree (`team`) and
   * their department's subtree (`department`).
   *
   * A user with no org unit gets empty sets, so `team`/`department` scopes
   * match nothing rather than everything — an unassigned account must not see
   * more than an assigned one.
   */
  async scopeSetsFor(user: { orgUnitId: string | null }): Promise<ScopeSets> {
    if (!user.orgUnitId) {
      return { teamOrgUnitIds: [], departmentOrgUnitIds: [] };
    }

    const teamOrgUnitIds = await this.closure.descendantIdsOf(user.orgUnitId);
    const departmentId = await this.nearestDepartmentId(user.orgUnitId);

    const departmentOrgUnitIds = departmentId
      ? await this.closure.descendantIdsOf(departmentId)
      : teamOrgUnitIds;

    return { teamOrgUnitIds, departmentOrgUnitIds };
  }

  /** Walks up the closure to the closest DEPARTMENT (or COMPANY) ancestor. */
  /**
   * The nearest department (or company) above a unit.
   *
   * Both the ancestors and their rows are fetched **once**. Looking each
   * ancestor up inside the loop was one round trip per level of the org
   * chart, on the path that resolves *every* request's principal — measured
   * at seconds against a remote database, which is what made core-service's
   * five-second resolve timeout fire on a cold call.
   */
  private async nearestDepartmentId(orgUnitId: string): Promise<string | null> {
    const ancestors = await this.closure.ancestorsOf(orgUnitId);
    if (!ancestors.length) return null;

    const ids = ancestors.map(({ ancestorId }) => ancestorId);

    const units = await this.orgUnits.findMany({
      where: { id: { in: ids }, kind: { in: ['DEPARTMENT', 'COMPANY'] } },
      select: { id: true },
    });

    const eligible = new Set(units.map((unit) => unit.id));

    // `ancestorsOf` is ordered nearest-first, so the first hit is the nearest.
    return ids.find((id) => eligible.has(id)) ?? null;
  }

  private async rebuildClosure(
    companyId: string,
    option?: TxOption,
  ): Promise<void> {
    const nodes = await this.orgUnits.findAllForClosure(companyId, option);
    await this.closure.rebuildForCompany(nodes, companyId, option);
  }

  private async requireSameCompany(
    parentId: string,
    companyId: string,
    option?: TxOption,
  ): Promise<void> {
    const parent = await this.orgUnits.findById(parentId, option);

    if (!parent || parent.companyId !== companyId) {
      throw new AppError(
        'VALIDATION_FAILED',
        'หน่วยงานแม่ต้องอยู่ในบริษัทเดียวกัน',
        [{ field: 'parent_id', reason: parentId }],
      );
    }
  }

  /**
   * Rejects re-parenting a unit under itself or one of its own descendants.
   * Without this the closure rebuild would loop, and the tree would stop
   * describing a hierarchy at all.
   */
  private async assertNoCycle(
    unitId: string,
    parentId: string | null | undefined,
    companyId: string,
    option?: TxOption,
  ): Promise<void> {
    if (!parentId) return;

    await this.requireSameCompany(parentId, companyId, option);

    if (parentId === unitId) {
      throw new AppError('ORG_UNIT_CYCLE', 'หน่วยงานเป็นแม่ของตัวเองไม่ได้', [
        { field: 'parent_id', reason: parentId },
      ]);
    }

    const descendants = await this.closure.descendantIdsOf(unitId, option);
    if (descendants.includes(parentId)) {
      throw new AppError(
        'ORG_UNIT_CYCLE',
        'ย้ายหน่วยงานไปอยู่ใต้หน่วยงานลูกของตัวเองไม่ได้',
        [{ field: 'parent_id', reason: parentId }],
      );
    }
  }
}
