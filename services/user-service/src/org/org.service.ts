import { Injectable } from '@nestjs/common';
import {
  AppError,
  PrismaTransactionService,
  TxOption,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import type { Company, OrgUnit, User } from '@prisma/client';
import { RolesService } from '../roles/roles.service';
import { AuditService } from '../audit/audit.service';
import { AuditEvent } from '../audit/audit-events';
import { UsersRepository } from '../users/users.repository';
import { CompanyRepository } from './company.repository';
import { OrgClosureRepository } from './org-closure.repository';
import { OrgUnitRepository } from './org-unit.repository';
import { OrgUnitScopeRepository } from './org-unit-scope.repository';
import {
  MembershipWithCompany,
  UserCompanyRepository,
} from './user-company.repository';
import {
  AssignUserOrgDto,
  CreateOrgUnitDto,
  ReplaceOrgUnitScopesDto,
  requireOneTarget,
  UpdateOrgUnitDto,
} from './dto/org-unit.dto';

/**
 * Everything a scope grant adds to one person's reach, in the active company.
 *
 * Four lists rather than two flags, because reading somebody's work and moving
 * it are different permissions (`canAct`), and because a grant may name a group
 * or one person — `assertMayAct` in core-service reads only the `act*` halves.
 */
export interface ScopedAccess {
  readUnits: string[];
  actUnits: string[];
  readUsers: string[];
  actUsers: string[];
}

function emptyScopedAccess(): ScopedAccess {
  return { readUnits: [], actUnits: [], readUsers: [], actUsers: [] };
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

/**
 * The chart as a requester sees it: shape only.
 *
 * A strict subset of {@link OrgUnitNode} on purpose — declaring it separately
 * rather than picking fields off that type is what stops a field added for the
 * admin screen from silently reaching everybody.
 */
export interface OrgUnitShape {
  id: string;
  code: string;
  name: string;
  kind: OrgUnit['kind'];
  parentId: string | null;
  /** A switched-off team: shown in the tree, but not choosable. */
  active: boolean;
}

/** One row of the A3 member panel. */
export interface OrgMember {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  /**
   * System roles bound in this company. `id` travels with the code so the
   * screen can edit a member's roles without a second lookup.
   */
  roles: { id: string; code: string; name: string; source: string }[];
  supervisor: { id: string; displayName: string } | null;
  /**
   * Realm roles from the last login. Per the A3 mockup this is the member's
   * **primary** role — "role หลักมาจาก Keycloak" — while the system roles
   * above are what an admin adjusts here.
   */
  keycloakRoles: string[];
}

@Injectable()
export class OrgService {
  constructor(
    private readonly companies: CompanyRepository,
    private readonly orgUnits: OrgUnitRepository,
    private readonly closure: OrgClosureRepository,
    private readonly scopes: OrgUnitScopeRepository,
    private readonly memberships: UserCompanyRepository,
    private readonly users: UsersRepository,
    private readonly roles: RolesService,
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
   * The chart's **shape** — what a requester needs to pick a receiving team.
   *
   * Deliberately less than {@link listUnitsWithDetail}: no manager name, no
   * member count. Those are what an administrator is looking at on A3, and a
   * person raising a request has no business reading them. What is left is the
   * outline of the organisation, which the company directory
   * (`GET /users`, the same `user.read`) already discloses by other means.
   *
   * Inactive units are **included**, carrying `active` so the caller can show
   * them greyed out. Filtering them here looked tidier and cut the chart in
   * half: a deactivated department would vanish, its positions would lose
   * their parent, and everybody in them would drop out of a picker that walks
   * down from the division above. `buildUnitTree` already says the same thing
   * — "removing it would re-hang its children at the root".
   */
  async listUnitShapes(companyId: string): Promise<OrgUnitShape[]> {
    const units = await this.orgUnits.findForCompanyWithDetail(companyId);

    return units.map((unit) => ({
      id: unit.id,
      code: unit.code,
      name: unit.name,
      kind: unit.kind,
      parentId: unit.parentId,
      active: unit.active,
    }));
  }

  /**
   * Members of one unit with the system roles and supervisor that screen A3
   * prints beside each name.
   *
   * Roles come from `RolesService` — the same resolution the guards use —
   * rather than a second query that could drift from what is enforced.
   *
   * The "scope:" tag this used to carry is gone with the scope levels
   * (31 Aug 2026): visibility now follows involvement and who leads the group,
   * so there is no per-person level left to print.
   */
  async listMembers(
    orgUnitId: string,
    companyId: string,
  ): Promise<OrgMember[]> {
    const members = await this.users.findMembersOf(orgUnitId);

    // One query for the whole panel. Asking per member was two round trips
    // each — a seventy-person department cost a hundred and forty.
    const rolesByUser = await this.roles.rolesForUsers(
      members.map((member) => member.id),
      companyId,
    );

    return members.map((member) => ({
      id: member.id,
      username: member.username,
      displayName: member.displayName,
      email: member.email,
      roles: (rolesByUser.get(member.id) ?? []).map((userRole) => ({
        id: userRole.role.id,
        code: userRole.role.code,
        name: userRole.role.name,
        source: userRole.source,
      })),
      supervisor: member.supervisor,
      keycloakRoles: member.keycloakRoles,
    }));
  }

  /**
   * Members of a group **and every group beneath it**.
   *
   * `listMembers` answers "who sits in this box", which is what the A3 panel
   * draws. This answers "who is under this part of the chart", which is what
   * choosing an approval level on A1 means — a department names its positions'
   * people, not its own empty membership.
   */
  async listMembersRecursive(
    orgUnitId: string,
    companyId: string,
  ): Promise<OrgMember[]> {
    const ids = await this.closure.descendantIdsOf(orgUnitId);
    const members = await this.users.findMembersOfMany(ids);

    const rolesByUser = await this.roles.rolesForUsers(
      members.map((member) => member.id),
      companyId,
    );

    return members.map((member) => ({
      id: member.id,
      username: member.username,
      displayName: member.displayName,
      email: member.email,
      roles: (rolesByUser.get(member.id) ?? []).map((userRole) => ({
        id: userRole.role.id,
        code: userRole.role.code,
        name: userRole.role.name,
        source: userRole.source,
      })),
      supervisor: member.supervisor,
      keycloakRoles: member.keycloakRoles,
    }));
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

  /**
   * Delete a group outright — only while nothing points at it.
   *
   * The chart is configuration, and an admin who mistypes a group needs to be
   * able to remove it rather than leave a deactivated box on the chart for
   * ever. What makes that safe is the refusal below, not restraint: a group
   * holding people, sub-groups, request types or dashboard audiences is
   * refused with `ORG_UNIT_IN_USE` naming each blocker, so the admin knows
   * what to move first — or can deactivate it instead and keep the history.
   *
   * `OrgClosure` rows go by cascade; the rest of the company's closure is
   * rebuilt in the same transaction, because scope answers read that table and
   * a stale one silently changes who sees what.
   */
  async deleteUnit(id: string, actor: Principal): Promise<void> {
    await this.transactions.execute(async (prisma) => {
      const option = { prisma };

      const before = await this.orgUnits.findById(id, option);
      if (!before) {
        throw new AppError('NOT_FOUND', 'ไม่พบหน่วยงานที่ระบุ');
      }

      const dependents = await this.orgUnits.countDependents(id, option);

      const blockers = [
        [dependents?.members, 'members', 'สมาชิก'],
        [dependents?.children, 'children', 'หน่วยงานย่อย'],
        [
          dependents?.receivedTypes,
          'request_types',
          'ประเภทคำขอที่ส่งมาที่นี่',
        ],
        [dependents?.biAudiences, 'bi_audiences', 'สิทธิ์เห็น dashboard'],
      ]
        .filter(([count]) => Number(count) > 0)
        .map(([count, field, label]) => ({
          field: String(field),
          reason: `${String(label)} ${String(count)}`,
        }));

      if (blockers.length) {
        throw new AppError(
          'ORG_UNIT_IN_USE',
          'ลบหน่วยงานนี้ไม่ได้เพราะยังมีข้อมูลอ้างอยู่ — ย้ายออกก่อน หรือปิดใช้งานแทน',
          blockers,
        );
      }

      await this.orgUnits.deleteUnit(id, option);
      await this.rebuildClosure(before.companyId, option);

      await this.audit.record(
        {
          eventType: AuditEvent.ORG_UNIT_DELETED,
          companyId: before.companyId,
          actorId: actor.userId,
          actorUsername: actor.username,
          resourceType: 'org_unit',
          resourceId: id,
          before,
        },
        option,
      );
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
   * Every group this person leads, plus every group beneath those.
   *
   * The one question the "งานทั้งหมด" screen, the approval chain's `org` levels
   * and every request list are answered from — see
   * `libs/share/src/access/access-rules.ts` for what is done with it.
   *
   * Leading nothing returns an empty array, and every caller treats that as
   * "no extra rows" rather than "no filter". An empty set that reads as
   * unrestricted is how a visibility bug becomes a disclosure.
   *
   * One query for the units and one for the closure, whatever the depth of the
   * chart. This runs while resolving *every* request's principal, and a round
   * trip per level here is what once made core-service's five-second resolve
   * timeout fire on a cold call.
   */
  async ledUnitIdsOf(userId: string, companyId: string): Promise<string[]> {
    const led = await this.orgUnits.findMany({
      where: { companyId, managerUserId: userId, active: true },
      select: { id: true },
    });

    if (!led.length) return [];

    const subtrees = await Promise.all(
      led.map((unit) => this.closure.descendantIdsOf(unit.id)),
    );

    return [...new Set(subtrees.flat())];
  }

  /**
   * Every group reached by the visibility levels this person's roles carry.
   *
   * A level is relative to the holder, not an absolute rank: walk up their own
   * ancestors, take the **nearest** unit whose `kind` matches, and read that
   * unit's subtree. Somebody under `ตำแหน่ง: software dev` with `DEPARTMENT`
   * reaches all of RND; the same role on somebody under Sale reaches Sale.
   * That is what a `(role, resource) → level` rule could never do, and why the
   * levels withdrawn on 31 ส.ค. 2569 are not what this is.
   *
   * A level with no matching ancestor contributes **nothing**. Widening to the
   * next unit up would be a silent grant, and it is exactly what would happen
   * to every `POSITION` role the day those nodes leave the chart.
   *
   * Several roles union, which is the same answer as "widest wins" — the
   * subtrees nest — without having to rank the kinds.
   *
   * `companyId` pins the ancestors read (SCOPE-03): somebody whose home unit
   * sits in another company must not reach it from this one. Descendants need
   * no such filter, a subtree never leaves its company's tree.
   */
  async levelUnitIdsOf(
    orgUnitId: string | null,
    companyId: string,
    levels: readonly OrgUnit['kind'][],
  ): Promise<string[]> {
    if (!orgUnitId || !levels.length) return [];

    const ancestors = await this.closure.ancestorsOf(orgUnitId);

    if (!ancestors.length) return [];

    const units = await this.orgUnits.findMany({
      where: {
        id: { in: ancestors.map((row) => row.ancestorId) },
        companyId,
        active: true,
      },
      select: { id: true, kind: true },
    });

    const kindOf = new Map(units.map((unit) => [unit.id, unit.kind]));

    /*
      `ancestorsOf` is ordered nearest first and includes the unit itself at
      depth 0, so the first match per level is the nearest one. Distinct roots
      only — two roles resolving to the same unit is one closure read, not two.
    */
    const roots = new Set<string>();

    for (const level of new Set(levels)) {
      const match = ancestors.find(
        (row) => kindOf.get(row.ancestorId) === level,
      );

      if (match) roots.add(match.ancestorId);
    }

    if (!roots.size) return [];

    const subtrees = await Promise.all(
      [...roots].map((rootId) => this.closure.descendantIdsOf(rootId)),
    );

    return [...new Set(subtrees.flat())];
  }

  // --- which groups may see which (SCOPE-01's replacement) ----------------

  /** The grants written on one group, as the admin screen lists them. */
  async listScopes(id: string, companyId: string) {
    await this.requireUnitInCompany(id, companyId);

    return this.scopes.findForViewerWithUnits(id);
  }

  /** The grants written on one person, as the same screen lists them. */
  async listUserScopes(userId: string, companyId: string) {
    await this.requireUserInCompany(userId, companyId);

    return this.scopes.findForViewerUserWithUnits(userId);
  }

  /**
   * Replaces every grant held by one group.
   *
   * Replace rather than add and remove per row: the screen edits a list and
   * saves it, and two endpoints each applying half of an edit is how a grant
   * survives being deleted.
   */
  async replaceScopes(
    id: string,
    dto: ReplaceOrgUnitScopesDto,
    companyId: string,
    actor: Principal,
  ) {
    await this.requireUnitInCompany(id, companyId);

    return this.replaceScopesFor(
      { viewerOrgUnitId: id },
      dto,
      companyId,
      actor,
    );
  }

  /**
   * Replaces every grant held by one *person* (4 ก.ย. 2569).
   *
   * The same list, saved the same way — the viewer is the only difference, so
   * the work is in {@link replaceScopesFor} rather than copied.
   */
  async replaceUserScopes(
    userId: string,
    dto: ReplaceOrgUnitScopesDto,
    companyId: string,
    actor: Principal,
  ) {
    await this.requireUserInCompany(userId, companyId);

    return this.replaceScopesFor(
      { viewerUserId: userId },
      dto,
      companyId,
      actor,
    );
  }

  /**
   * The body of both replace endpoints.
   *
   * Every target is checked against the same company (SCOPE-03). A grant is
   * the one place a request could cross a company boundary now that the `all`
   * scope level is gone, so it is refused here rather than filtered later —
   * the filter would have to know which rows to drop, and it does not.
   */
  private async replaceScopesFor(
    viewer: { viewerOrgUnitId: string } | { viewerUserId: string },
    dto: ReplaceOrgUnitScopesDto,
    companyId: string,
    actor: Principal,
  ) {
    const viewerId =
      'viewerOrgUnitId' in viewer
        ? viewer.viewerOrgUnitId
        : viewer.viewerUserId;

    for (const entry of dto.scopes) {
      const target = requireOneTarget(entry);

      /*
        A viewer already sees its own work, so a self-grant is a row that
        changes nothing — refused rather than stored, because a stored one
        invites the reader to believe it is load-bearing.
      */
      if (target.id === viewerId) {
        throw new AppError(
          'VALIDATION_FAILED',
          target.kind === 'unit'
            ? 'หน่วยงานเห็นงานของตัวเองอยู่แล้ว ไม่ต้องตั้งสิทธิ์ซ้ำ'
            : 'ผู้ใช้เห็นงานของตัวเองอยู่แล้ว ไม่ต้องตั้งสิทธิ์ซ้ำ',
          [{ field: target.field, reason: target.id }],
        );
      }

      if (target.kind === 'unit') {
        await this.requireUnitInCompany(target.id, companyId);
      } else {
        await this.requireUserInCompany(target.id, companyId);
      }
    }

    return this.transactions.execute(async (prisma) => {
      const option = { prisma };

      const before =
        'viewerOrgUnitId' in viewer
          ? await this.scopes.findForViewers(
              [viewer.viewerOrgUnitId],
              companyId,
              undefined,
              option,
            )
          : await this.scopes.findForViewers(
              [],
              companyId,
              viewer.viewerUserId,
              option,
            );

      await prisma.orgUnitScope.deleteMany({ where: viewer });

      const written = await Promise.all(
        dto.scopes.map((entry) => {
          const target = requireOneTarget(entry);

          return prisma.orgUnitScope.create({
            data: {
              companyId,
              ...viewer,
              targetOrgUnitId: target.kind === 'unit' ? target.id : null,
              targetUserId: target.kind === 'user' ? target.id : null,
              /*
                A person has no subtree. Storing `true` there would be a flag
                that reads as if it widened the grant, and the database
                refuses it outright.
              */
              includeDescendants:
                target.kind === 'unit'
                  ? (entry.include_descendants ?? true)
                  : false,
              canAct: entry.can_act ?? false,
              createdBy: actor.userId,
              updatedBy: actor.userId,
            },
          });
        }),
      );

      await this.audit.record(
        {
          eventType: AuditEvent.ORG_UNIT_SCOPES_REPLACED,
          companyId,
          actorId: actor.userId,
          actorUsername: actor.username,
          resourceType: 'viewerOrgUnitId' in viewer ? 'org_unit' : 'user',
          resourceId: viewerId,
          before: { scopes: before },
          after: { scopes: written },
        },
        option,
      );

      return written;
    });
  }

  /**
   * The unit, proved to be in the caller's company.
   *
   * SCOPE-03: a unit in another company answers 404 rather than 403 — the
   * spec does not want existence disclosed across the boundary.
   */
  private async requireUnitInCompany(id: string, companyId: string) {
    const unit = await this.orgUnits.findById(id);

    if (!unit || unit.companyId !== companyId) {
      throw new AppError('NOT_FOUND', 'ไม่พบหน่วยงานที่ระบุ');
    }

    return unit;
  }

  /**
   * The person, proved to be a member of the caller's company.
   *
   * Membership rather than `primaryCompanyId` (AUTH-05): somebody can work in
   * a company that is not their primary one, and a grant naming them there is
   * legitimate. Same 404-not-403 rule as {@link requireUnitInCompany}.
   */
  private async requireUserInCompany(userId: string, companyId: string) {
    const user = await this.users.findFirst({
      where: { id: userId, companies: { some: { companyId } } },
    });

    if (!user) throw new AppError('NOT_FOUND', 'ไม่พบผู้ใช้ที่ระบุ');

    return user;
  }

  /**
   * The groups **and people** this person may see through a scope grant, and
   * the subsets they may also act in.
   *
   * The other way into somebody else's work, beside leading a group
   * ({@link ledUnitIdsOf}). Deliberately built the same way: one query for the
   * grants and one closure read per expanded target, never a walk down the
   * tree per level.
   *
   * **A grant is inherited downwards.** A grant written to a *group* is
   * matched against the person's own unit *and every unit above it*, which is
   * what "เลือก level" means on the admin screen: one written on the company
   * applies to everyone in it, one on a ฝ่าย applies to its แผนก, and one on a
   * ตำแหน่ง applies to that position alone.
   *
   * **A grant written to a person is not inherited by anything.** It names one
   * account, which is the whole point of being able to write it (4 ก.ย. 2569)
   * — one designer covering one account manager's work, without handing over
   * either group.
   *
   * Somebody with no unit and no personal grant gets four empty arrays — and
   * every caller treats an empty set as "no extra rows" rather than "no
   * filter". An empty set that reads as unrestricted is how a visibility bug
   * becomes a disclosure.
   */
  async scopedAccessOf(
    userId: string,
    companyId: string,
  ): Promise<ScopedAccess> {
    const user = await this.users.findById(userId);

    if (!user) return emptyScopedAccess();

    /*
      No unit is no longer the end of the story: somebody in the รอจัดสังกัด
      queue can still hold a grant written to them by name.
    */
    const ancestors = user.orgUnitId
      ? await this.closure.ancestorsOf(user.orgUnitId)
      : [];

    const grants = await this.scopes.findForViewers(
      ancestors.map((row) => row.ancestorId),
      companyId,
      userId,
    );

    if (!grants.length) return emptyScopedAccess();

    /*
      Expanded once per distinct target, not once per grant: two grants on the
      same group — one inherited from the ฝ่าย, one written on the แผนก — are
      the same subtree, and the closure read is the expensive half.
    */
    const unitTargets = [
      ...new Set(
        grants
          .map((grant) => grant.targetOrgUnitId)
          .filter((id): id is string => id !== null),
      ),
    ];

    const subtrees = new Map<string, string[]>();

    await Promise.all(
      unitTargets.map(async (targetId) => {
        subtrees.set(targetId, await this.closure.descendantIdsOf(targetId));
      }),
    );

    const readUnits = new Set<string>();
    const actUnits = new Set<string>();
    const readUsers = new Set<string>();
    const actUsers = new Set<string>();

    for (const grant of grants) {
      if (grant.targetUserId) {
        readUsers.add(grant.targetUserId);
        if (grant.canAct) actUsers.add(grant.targetUserId);
        continue;
      }

      if (!grant.targetOrgUnitId) continue;

      const reached = grant.includeDescendants
        ? (subtrees.get(grant.targetOrgUnitId) ?? [grant.targetOrgUnitId])
        : [grant.targetOrgUnitId];

      for (const unitId of reached) {
        readUnits.add(unitId);
        if (grant.canAct) actUnits.add(unitId);
      }
    }

    return {
      readUnits: [...readUnits],
      actUnits: [...actUnits],
      readUsers: [...readUsers],
      actUsers: [...actUsers],
    };
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
