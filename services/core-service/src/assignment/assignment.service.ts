import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AppError,
  AuditWriter,
  auditActor,
  Principal,
} from '@request-management/share';
import { LeadRepository } from '../crm/sales.repositories';
import { LeadsService } from '../crm/leads.service';
import { thaiToday } from '../crm/vendor-costs';
import { AvailabilityService } from '../hr/availability.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  ASSIGNMENT_ROLES,
  type Candidate,
  cleanConditions,
  type Conditions,
  type Criteria,
  pickCandidate,
  ruleMatches,
} from './assignment-rules';
import {
  AssignmentRefsRepository,
  AssignmentRepository,
  AssignmentRoleSettingRepository,
  AssignmentRuleRepository,
  type TeamMember,
} from './assignment.repository';
import {
  AssignmentResultDto,
  AssignWorkDto,
  CreateAssignmentRuleDto,
  NotifyUserDto,
  UpdateAssignmentRoleDto,
  UpdateAssignmentRuleDto,
} from './dto/assignment.dto';

const HISTORY_PAGE = 100;

interface RuleRow {
  id: string;
  companyId: string;
  role: string;
  name: string;
  orgUnitId: string;
  conditions: Prisma.JsonValue;
  sortOrder: number;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface AssignmentRow {
  id: string;
  role: string;
  resourceType: string;
  resourceId: string;
  userId: string;
  ruleId: string | null;
  orgUnitId: string | null;
  reason: string;
  criteria: Prisma.JsonValue;
  createdAt: Date;
}

interface Pick {
  person: TeamMember;
  rule: RuleRow | null;
  reason: 'matched' | 'fallback';
}

/**
 * ตารางทีม (เส้นทาง Lead ถึงบริการ Phase 0, 2 พ.ย. 2569).
 *
 * The admin keeps the table; the workflow asks "who gets this?" and the answer
 * comes from data only — which rule the work matches, who in that team is not
 * on leave, who holds the least open work, who waited longest. Whether to ask,
 * and what happens next, stays on the workflow ("Workflow owns Process, Core
 * owns Data"). Every route is pinned to the caller's company (SCOPE-03).
 */
@Injectable()
export class AssignmentService {
  constructor(
    private readonly rules: AssignmentRuleRepository,
    private readonly roleSettings: AssignmentRoleSettingRepository,
    private readonly assignments: AssignmentRepository,
    private readonly refs: AssignmentRefsRepository,
    private readonly leads: LeadRepository,
    private readonly leadsService: LeadsService,
    private readonly availability: AvailabilityService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditWriter,
  ) {}

  // --- admin: the table -------------------------------------------------

  roles() {
    return Object.entries(ASSIGNMENT_ROLES).map(([key, spec]) => ({
      key,
      label: spec.label,
      fields: spec.fields,
    }));
  }

  async listRules(actor: Principal) {
    const companyId = actor.activeCompanyId;
    const rows = (await this.rules.findMany({
      where: { companyId },
      orderBy: [{ role: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
    })) as RuleRow[];
    const settings = (await this.roleSettings.findMany({
      where: { companyId },
    })) as {
      role: string;
      fallbackUserId: string | null;
      loadTypeCodes: string[];
    }[];
    return {
      rules: rows.map(ruleView),
      roles: Object.keys(ASSIGNMENT_ROLES).map((role) => {
        const setting = settings.find((s) => s.role === role);
        return {
          role,
          fallback_user_id: setting?.fallbackUserId ?? null,
          load_type_codes: setting?.loadTypeCodes ?? [],
        };
      }),
    };
  }

  async createRule(dto: CreateAssignmentRuleDto, actor: Principal) {
    const companyId = actor.activeCompanyId;
    await this.requireUnit(companyId, dto.org_unit_id);
    const row = (await this.rules.create({
      data: {
        companyId,
        role: dto.role,
        name: dto.name.trim(),
        orgUnitId: dto.org_unit_id,
        conditions: cleanConditions(dto.role, dto.conditions),
        sortOrder: dto.sort_order ?? 0,
        createdBy: actor.userId,
      },
    })) as RuleRow;
    await this.audit.record({
      eventType: 'admin.assignment_rule.created',
      companyId,
      ...auditActor(actor),
      resourceType: 'assignment_rule',
      resourceId: row.id,
      after: ruleView(row),
    });
    return ruleView(row);
  }

  async updateRule(id: string, dto: UpdateAssignmentRuleDto, actor: Principal) {
    const companyId = actor.activeCompanyId;
    const before = (await this.rules.findFirst({
      where: { id, companyId },
    })) as RuleRow | null;
    if (!before) throw new AppError('NOT_FOUND', 'ไม่พบกฎที่ระบุ');
    if (dto.org_unit_id) await this.requireUnit(companyId, dto.org_unit_id);
    const row = (await this.rules.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.org_unit_id ? { orgUnitId: dto.org_unit_id } : {}),
        ...(dto.conditions !== undefined
          ? { conditions: cleanConditions(before.role, dto.conditions) }
          : {}),
        ...(dto.sort_order !== undefined ? { sortOrder: dto.sort_order } : {}),
        ...(dto.active !== undefined ? { active: dto.active } : {}),
        updatedBy: actor.userId,
      },
    })) as RuleRow;
    await this.audit.record({
      eventType: 'admin.assignment_rule.updated',
      companyId,
      ...auditActor(actor),
      resourceType: 'assignment_rule',
      resourceId: id,
      before: ruleView(before),
      after: ruleView(row),
    });
    return ruleView(row);
  }

  async updateRole(role: string, dto: UpdateAssignmentRoleDto, actor: Principal) {
    if (!ASSIGNMENT_ROLES[role]) {
      throw new AppError('NOT_FOUND', `ไม่รู้จักบทบาท ${role}`);
    }
    const companyId = actor.activeCompanyId;
    if (dto.fallback_user_id) {
      const person = await this.refs.person(companyId, dto.fallback_user_id);
      if (!person) {
        throw new AppError('VALIDATION_FAILED', 'คนรับสำรองต้องอยู่ในบริษัทนี้', [
          { field: 'fallback_user_id', reason: 'not_member' },
        ]);
      }
    }
    const codes = dto.load_type_codes?.map((c) => c.trim().toUpperCase()).filter(Boolean);
    const data = {
      ...(dto.fallback_user_id !== undefined
        ? { fallbackUserId: dto.fallback_user_id || null }
        : {}),
      ...(codes !== undefined ? { loadTypeCodes: [...new Set(codes)] } : {}),
      updatedBy: actor.userId,
    };
    const row = (await this.roleSettings.upsert({
      where: { companyId_role: { companyId, role } },
      create: { companyId, role, ...data },
      update: data,
    })) as { fallbackUserId: string | null; loadTypeCodes: string[] };
    await this.audit.record({
      eventType: 'admin.assignment_role.updated',
      companyId,
      ...auditActor(actor),
      resourceType: 'assignment_role',
      resourceId: role,
      after: { fallbackUserId: row.fallbackUserId, loadTypeCodes: row.loadTypeCodes },
    });
    return {
      role,
      fallback_user_id: row.fallbackUserId,
      load_type_codes: row.loadTypeCodes,
    };
  }

  async history(actor: Principal, role?: string) {
    const rows = (await this.assignments.findMany({
      where: {
        companyId: actor.activeCompanyId,
        ...(role ? { role } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: HISTORY_PAGE,
    })) as AssignmentRow[];
    return rows.map((row) => ({
      id: row.id,
      role: row.role,
      resource_type: row.resourceType,
      resource_id: row.resourceId,
      user_id: row.userId,
      rule_id: row.ruleId,
      org_unit_id: row.orgUnitId,
      reason: row.reason,
      criteria: row.criteria,
      created_at: row.createdAt.toISOString(),
    }));
  }

  /** ลองจับคู่โดยไม่บันทึก — หน้า admin ใช้ตรวจตาราง. */
  async preview(role: string, criteria: Criteria, actor: Principal) {
    const pick = await this.pick(actor.activeCompanyId, role, criteria);
    return {
      user_id: pick.person.id,
      user_name: pick.person.displayName,
      reason: pick.reason,
      rule_id: pick.rule?.id ?? null,
    };
  }

  // --- the workflow asks ------------------------------------------------

  /**
   * Pick someone for one piece of work and, for a Lead, make them its owner.
   *
   * Idempotent on `request_key` — Flowable retries an HTTP task, and a retry
   * must not hand the same Lead round the queue twice. A Lead that already has
   * an owner keeps it (a salesperson who keyed their own Lead is not robbed of
   * it); the answer then names that owner with reason `kept`.
   */
  async assign(dto: AssignWorkDto, actor: Principal): Promise<AssignmentResultDto> {
    const companyId = actor.activeCompanyId;

    if (dto.request_key) {
      const earlier = (await this.assignments.findFirst({
        where: { companyId, requestKey: dto.request_key },
      })) as AssignmentRow | null;
      if (earlier) {
        const person = await this.refs.person(companyId, earlier.userId);
        return result(earlier, person, true);
      }
    }

    let criteria: Criteria = { ...(dto.criteria ?? {}) };
    if (dto.resource_type === 'lead') {
      const lead = await this.requireLead(companyId, dto.resource_id);
      if (lead.ownerUserId) {
        const owner = await this.refs.person(companyId, lead.ownerUserId);
        return {
          assignment_id: '',
          user_id: lead.ownerUserId,
          user_email: owner?.email ?? null,
          user_name: owner?.displayName ?? lead.ownerUserId,
          reason: 'kept',
          rule_id: null,
          org_unit_id: null,
          applied: false,
          replayed: false,
        };
      }
      criteria = { ...leadCriteria(lead), ...criteria };
    }

    const pick = await this.pick(companyId, dto.role, criteria);

    let applied = false;
    if (dto.resource_type === 'lead') {
      await this.leadsService.assign(
        dto.resource_id,
        { owner_user_id: pick.person.id },
        actor,
      );
      applied = true;
    }

    const row = (await this.assignments.create({
      data: {
        companyId,
        role: dto.role,
        resourceType: dto.resource_type,
        resourceId: dto.resource_id,
        userId: pick.person.id,
        ruleId: pick.rule?.id ?? null,
        orgUnitId: pick.rule?.orgUnitId ?? null,
        reason: pick.reason,
        criteria: criteria as Prisma.InputJsonValue,
        requestKey: dto.request_key ?? null,
        createdBy: actor.userId,
      },
    })) as AssignmentRow;

    await this.audit.record({
      eventType: 'integration.assignment.made',
      companyId,
      ...auditActor(actor),
      resourceType: dto.resource_type,
      resourceId: dto.resource_id,
      after: {
        role: dto.role,
        userId: pick.person.id,
        reason: pick.reason,
        ruleId: pick.rule?.id ?? null,
      },
    });

    await this.notifications.workflowNotice(
      pick.person.id,
      companyId,
      'workflow.assigned',
      {
        role: ASSIGNMENT_ROLES[dto.role].label,
        subject: `${dto.resource_type} ${dto.resource_id}`,
        reason: pick.rule
          ? `ตรงกฎ ${pick.rule.name}`
          : 'ไม่ตรงกฎในตารางทีม — ส่งคนรับสำรอง',
      },
      notifiable(dto.resource_type)
        ? { type: dto.resource_type, id: dto.resource_id }
        : null,
    );

    return result(row, pick.person, false, applied);
  }

  /** A workflow step tells one person of this company something. */
  async notify(dto: NotifyUserDto, actor: Principal) {
    const companyId = actor.activeCompanyId;
    const person = await this.refs.person(companyId, dto.user_id);
    if (!person) throw new AppError('NOT_FOUND', 'ไม่พบผู้รับในบริษัทนี้');
    if (Boolean(dto.resource_type) !== Boolean(dto.resource_id)) {
      throw new AppError(
        'VALIDATION_FAILED',
        'ส่ง resource_type คู่กับ resource_id',
        [{ field: 'resource_id', reason: 'pair' }],
      );
    }
    await this.notifications.workflowNotice(
      person.id,
      companyId,
      'workflow.notice',
      { title: dto.title.trim(), body: dto.body?.trim() ?? '' },
      dto.resource_type && dto.resource_id
        ? { type: dto.resource_type, id: dto.resource_id }
        : null,
    );
    return { user_id: person.id, sent: true };
  }

  // --- the choice -------------------------------------------------------

  /**
   * Rules in order; the first that matches *and* has someone available wins.
   * A matching team where everybody is on leave falls through to the next
   * matching rule, then to the role's fallback person (who is never skipped
   * for leave — somebody must hold the work), then to the matched team's head.
   */
  private async pick(companyId: string, role: string, criteria: Criteria): Promise<Pick> {
    if (!ASSIGNMENT_ROLES[role]) {
      throw new AppError('VALIDATION_FAILED', `ไม่รู้จักบทบาท ${role}`);
    }
    const rules = (await this.rules.findMany({
      where: { companyId, role, active: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    })) as RuleRow[];
    const setting = (await this.roleSettings.findFirst({
      where: { companyId, role },
    })) as { fallbackUserId: string | null; loadTypeCodes: string[] } | null;

    const matched = rules.filter((rule) =>
      ruleMatches(rule.conditions as Conditions, criteria),
    );

    for (const rule of matched) {
      const members = await this.available(
        companyId,
        await this.refs.members(companyId, rule.orgUnitId),
      );
      if (!members.length) continue;
      const loads = await this.loads(companyId, role, members, setting);
      const last = await this.assignments.lastAssigned(
        companyId,
        role,
        members.map((m) => m.id),
      );
      const chosen = pickCandidate(
        members.map<Candidate>((m) => ({
          userId: m.id,
          open: loads.get(m.id) ?? 0,
          lastAssignedAt: last.get(m.id) ?? null,
        })),
      );
      const person = members.find((m) => m.id === chosen?.userId);
      if (person) return { person, rule, reason: 'matched' };
    }

    if (setting?.fallbackUserId) {
      const person = await this.refs.person(companyId, setting.fallbackUserId);
      if (person) return { person, rule: null, reason: 'fallback' };
    }
    for (const rule of matched) {
      const unit = await this.refs.managerOf(companyId, rule.orgUnitId);
      if (!unit?.managerUserId) continue;
      const person = await this.refs.person(companyId, unit.managerUserId);
      if (person) return { person, rule: null, reason: 'fallback' };
    }
    throw new AppError(
      'CONFLICT',
      `ไม่มีคนรับงาน${ASSIGNMENT_ROLES[role].label} — ตั้งคนรับสำรองในหน้าตารางทีม`,
      [{ field: 'role', reason: 'no_assignee' }],
    );
  }

  /** ตัดคนที่ลาเต็มวันในวันทำงานนี้ (CD-232); ไม่อยู่ในทะเบียน HR = ว่าง. */
  private async available(companyId: string, members: TeamMember[]) {
    if (!members.length) return members;
    const today = thaiToday();
    const grid = (await this.availability.availabilityFor(
      companyId,
      members.map((m) => m.id),
      today,
      today,
    )) as Map<string, { capacity: number; leaveHours: number }[]>;
    return members.filter((m) => {
      const day = grid.get(m.id)?.[0];
      return !day || day.capacity === 0 || day.leaveHours < day.capacity;
    });
  }

  private loads(
    companyId: string,
    role: string,
    members: TeamMember[],
    setting: { loadTypeCodes: string[] } | null,
  ) {
    const ids = members.map((m) => m.id);
    if (role === 'sales') return this.refs.salesLoad(companyId, ids);
    if (role === 'pm') return this.refs.projectLoad(companyId, ids);
    return this.refs.requestLoad(companyId, ids, setting?.loadTypeCodes ?? []);
  }

  private async requireUnit(companyId: string, orgUnitId: string) {
    const unit = await this.refs.managerOf(companyId, orgUnitId);
    if (!unit?.active) {
      throw new AppError('VALIDATION_FAILED', 'ไม่พบทีมนี้ในผังองค์กรของบริษัท', [
        { field: 'org_unit_id', reason: 'not_found' },
      ]);
    }
  }

  private async requireLead(companyId: string, id: string) {
    const lead = (await this.leads.findFirst({
      where: { id, companyId },
      select: {
        id: true,
        ownerUserId: true,
        industry: true,
        productGroup: true,
        companySize: true,
        province: true,
      },
    })) as LeadCriteriaRow | null;
    if (!lead) throw new AppError('NOT_FOUND', 'ไม่พบ Lead ที่ระบุ');
    return lead;
  }
}

interface LeadCriteriaRow {
  id: string;
  ownerUserId: string | null;
  industry: string | null;
  productGroup: string | null;
  companySize: string | null;
  province: string | null;
}

const leadCriteria = (lead: LeadCriteriaRow): Criteria => ({
  industry: lead.industry,
  productGroup: lead.productGroup,
  companySize: lead.companySize,
  province: lead.province,
});

/** The resource types a notification links to on screen. */
const notifiable = (type: string) =>
  ['lead', 'opportunity', 'request', 'project'].includes(type);

function ruleView(row: RuleRow) {
  return {
    id: row.id,
    role: row.role,
    name: row.name,
    org_unit_id: row.orgUnitId,
    conditions: row.conditions,
    sort_order: row.sortOrder,
    active: row.active,
    updated_at: row.updatedAt.toISOString(),
  };
}

function result(
  row: AssignmentRow,
  person: TeamMember | null,
  replayed: boolean,
  applied = row.resourceType === 'lead',
): AssignmentResultDto {
  return {
    assignment_id: row.id,
    user_id: row.userId,
    user_email: person?.email ?? null,
    user_name: person?.displayName ?? row.userId,
    reason: row.reason,
    rule_id: row.ruleId,
    org_unit_id: row.orgUnitId,
    applied,
    replayed,
  };
}
