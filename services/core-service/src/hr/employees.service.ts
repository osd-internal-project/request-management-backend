import { Injectable } from '@nestjs/common';
import {
  AppError,
  AuditWriter,
  auditActor,
  Principal,
  PrismaTransactionService,
} from '@request-management/share';
import { thaiToday } from '../crm/vendor-costs';
import {
  HrEmployeeRepository,
  HrLevelRepository,
  HrMemberRepository,
  HrReportingRepository,
  HrSkillRepository,
  HrUserSkillRepository,
} from './hr.repositories';
import {
  ListEmployeesQueryDto,
  SaveEmployeeDto,
  SaveEmployeeSkillsDto,
  SaveSkillDto,
} from './hr.dto';

const LIST_LIMIT = 1000;
const day = (value: Date | null) =>
  value ? value.toISOString().slice(0, 10) : null;
const date = (value: string) => new Date(`${value}T00:00:00Z`);

interface Member {
  user: {
    id: string;
    displayName: string;
    email: string | null;
    employeeId: string | null;
    position: string | null;
    phone: string | null;
    extension: string | null;
    startWork: Date | null;
    status: string;
    orgUnit: { id: string; name: string } | null;
    supervisor: { id: string; displayName: string } | null;
  };
}

interface Profile {
  userId: string;
  levelId: string | null;
  employmentType: string;
  status: string;
  endDate: Date | null;
  note: string;
  updatedAt: Date;
  level: { id: string; code: string; name: string } | null;
}

interface UserSkill {
  userId: string;
  skillId: string;
  proficiency: number;
  certificate: string;
  certExpiresOn: Date | null;
  note: string;
  skill: { id: string; code: string; name: string; category: string };
}

/**
 * CD-229 — ทะเบียนพนักงาน (part of CD-17 HR).
 *
 * The people are the company's members in the user directory, which LDAP
 * keeps (name, email, position, unit, supervisor, start date) — read here,
 * never created or edited. HR adds its own facts per person × company: the
 * level (CD-207's, of that company), employment type and status; and per
 * person, skills from the shared catalog with a proficiency of 1–3 and any
 * certificate.
 *
 * HR (`hr.employee.read` / `.manage`) sees and keeps the register; anyone
 * sees their own profile. Finer visibility for managers is CD-230.
 */
@Injectable()
export class EmployeesService {
  constructor(
    private readonly members: HrMemberRepository,
    private readonly employees: HrEmployeeRepository,
    private readonly levels: HrLevelRepository,
    private readonly skills: HrSkillRepository,
    private readonly userSkills: HrUserSkillRepository,
    private readonly reporting: HrReportingRepository,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  async list(actor: Principal, query: ListEmployeesQueryDto) {
    const companyId = actor.activeCompanyId;
    const q = query.q?.trim();
    const members = (await this.members.findMany({
      where: {
        companyId,
        ...(q
          ? {
              user: {
                OR: [
                  { displayName: { contains: q, mode: 'insensitive' } },
                  { email: { contains: q, mode: 'insensitive' } },
                  { employeeId: { contains: q, mode: 'insensitive' } },
                  { position: { contains: q, mode: 'insensitive' } },
                ],
              },
            }
          : {}),
      },
      include: { user: { select: USER_SELECT } },
      take: LIST_LIMIT,
    })) as unknown as Member[];
    const ids = members.map((member) => member.user.id);
    const [profiles, skills] = await Promise.all([
      this.profilesOf(companyId, ids),
      this.skillsOf(ids),
    ]);
    let rows = members.map((member) =>
      view(member, profiles.get(member.user.id), skills.get(member.user.id)),
    );
    if (query.level_id) {
      rows = rows.filter((row) => row.profile.levelId === query.level_id);
    }
    if (query.skill_id) {
      rows = rows.filter((row) =>
        row.skills.some((skill) => skill.skillId === query.skill_id),
      );
    }
    if (query.status) {
      rows = rows.filter((row) => row.profile.status === query.status);
    }
    return {
      items: rows.sort((a, b) =>
        a.displayName.localeCompare(b.displayName, 'th'),
      ),
    };
  }

  /**
   * One person — CD-230: HR sees all of it; a supervisor sees someone below
   * them (any depth) without the employment terms; the person sees their own.
   * Opening someone else's profile is recorded (SCOPE-05).
   */
  async findOne(actor: Principal, userId: string) {
    const self = userId === actor.userId;
    const hr = isHr(actor);
    const supervises =
      !self && !hr
        ? (await this.reporting.subordinatesOf(actor.userId)).includes(userId)
        : false;
    if (!self && !hr && !supervises) {
      // SCOPE-03 — not disclosed.
      throw new AppError('NOT_FOUND', 'ไม่พบพนักงานที่ระบุ');
    }
    const member = await this.requireMember(actor.activeCompanyId, userId);
    const [profiles, skills] = await Promise.all([
      this.profilesOf(actor.activeCompanyId, [userId]),
      this.skillsOf([userId]),
    ]);
    const row = view(member, profiles.get(userId), skills.get(userId));
    if (!self) {
      await this.audit.record({
        eventType: 'hr.employee.viewed',
        companyId: actor.activeCompanyId,
        ...auditActor(actor),
        resourceType: 'user',
        resourceId: userId,
        after: { as: hr ? 'hr' : 'supervisor' },
      });
    }
    return hr || self ? row : teamView(row);
  }

  /** CD-230 — the people below the caller (any depth), as a supervisor sees them. */
  async team(actor: Principal) {
    const ids = await this.reporting.subordinatesOf(actor.userId);
    if (!ids.length) return { items: [] };
    const rows = await this.rowsFor(actor.activeCompanyId, ids);
    return { items: rows.map(teamView) };
  }

  /**
   * CD-230 — the staffing directory for PM and Pre-Sales: who is here, where,
   * at what level, with which skills. Nothing about employment or pay, and
   * nobody who has left.
   */
  async staff(actor: Principal, query: ListEmployeesQueryDto) {
    const { items } = await this.list(actor, query);
    return {
      items: items
        .filter(
          (row) =>
            row.profile.status !== 'resigned' && row.accountStatus === 'ACTIVE',
        )
        .map(staffView),
    };
  }

  async saveProfile(actor: Principal, userId: string, dto: SaveEmployeeDto) {
    const companyId = actor.activeCompanyId;
    await this.requireMember(companyId, userId);
    if (dto.level_id) {
      const level = await this.levels.findFirst({
        where: { id: dto.level_id, companyId },
      });
      if (!level) {
        throw new AppError('VALIDATION_FAILED', 'ไม่พบระดับนี้ในบริษัท', [
          { field: 'level_id', reason: 'unknown' },
        ]);
      }
    }
    const data = {
      ...(dto.level_id !== undefined ? { levelId: dto.level_id || null } : {}),
      ...(dto.employment_type ? { employmentType: dto.employment_type } : {}),
      ...(dto.status ? { status: dto.status } : {}),
      ...(dto.end_date !== undefined
        ? { endDate: dto.end_date ? date(dto.end_date) : null }
        : {}),
      ...(dto.note !== undefined ? { note: dto.note.trim() } : {}),
      updatedBy: actor.userId,
    };
    await this.transactions.execute(async (prisma) => {
      await prisma.hrEmployee.upsert({
        where: { companyId_userId: { companyId, userId } },
        create: { companyId, userId, ...data },
        update: data,
      });
      await this.audit.record(
        {
          eventType: 'hr.employee.saved',
          companyId,
          ...auditActor(actor),
          resourceType: 'user',
          resourceId: userId,
          after: { ...dto },
        },
        { prisma },
      );
    });
    return this.findOne(actor, userId);
  }

  /** The person's whole skill set, as sent; one left out is taken off. */
  async saveSkills(
    actor: Principal,
    userId: string,
    dto: SaveEmployeeSkillsDto,
  ) {
    await this.requireMember(actor.activeCompanyId, userId);
    const ids = dto.skills.map((skill) => skill.skill_id);
    if (new Set(ids).size !== ids.length) {
      throw new AppError('VALIDATION_FAILED', 'ทักษะซ้ำในรายการ', [
        { field: 'skills', reason: 'duplicate' },
      ]);
    }
    const known = (await this.skills.findMany({
      where: { id: { in: ids } },
      select: { id: true },
    })) as { id: string }[];
    if (known.length !== ids.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        'มีทักษะที่ไม่อยู่ในรายการของ HR',
        [{ field: 'skills', reason: 'unknown_skill' }],
      );
    }
    await this.transactions.execute(async (prisma) => {
      for (const skill of dto.skills) {
        const data = {
          proficiency: skill.proficiency,
          certificate: skill.certificate?.trim() ?? '',
          certExpiresOn: skill.cert_expires_on
            ? date(skill.cert_expires_on)
            : null,
          note: skill.note?.trim() ?? '',
          updatedBy: actor.userId,
          deletedAt: null,
        };
        await prisma.hrUserSkill.upsert({
          where: { userId_skillId: { userId, skillId: skill.skill_id } },
          create: { userId, skillId: skill.skill_id, ...data },
          update: data,
        });
      }
      await prisma.hrUserSkill.updateMany({
        where: { userId, skillId: { notIn: ids }, deletedAt: null },
        data: { deletedAt: new Date(), updatedBy: actor.userId },
      });
      await this.audit.record(
        {
          eventType: 'hr.employee.skills_saved',
          companyId: actor.activeCompanyId,
          ...auditActor(actor),
          resourceType: 'user',
          resourceId: userId,
          after: {
            skills: dto.skills.map((skill) => ({
              skillId: skill.skill_id,
              proficiency: skill.proficiency,
            })),
          },
        },
        { prisma },
      );
    });
    return this.findOne(actor, userId);
  }

  /** The catalog; the inactive ones only for whoever keeps it. */
  async skillCatalog(actor: Principal) {
    const keeper = actor.permissions.includes('hr.employee.manage');
    return {
      items: await this.skills.findMany({
        where: keeper ? {} : { active: true },
        orderBy: [{ category: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
      }),
    };
  }

  async saveSkill(actor: Principal, id: string | null, dto: SaveSkillDto) {
    if (id) {
      const found = await this.skills.findFirst({ where: { id } });
      if (!found) throw new AppError('NOT_FOUND', 'ไม่พบทักษะที่ระบุ');
      await this.skills.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.category !== undefined
            ? { category: dto.category.trim() }
            : {}),
          ...(dto.sort_order !== undefined
            ? { sortOrder: dto.sort_order }
            : {}),
          ...(dto.active !== undefined ? { active: dto.active } : {}),
        },
      });
    } else {
      const code = dto.code?.trim().toUpperCase();
      const name = dto.name?.trim();
      if (!code || !name) {
        throw new AppError('VALIDATION_FAILED', 'ต้องระบุรหัสและชื่อทักษะ', [
          { field: code ? 'name' : 'code', reason: 'required' },
        ]);
      }
      if (await this.skills.findFirst({ where: { code } })) {
        throw new AppError('CONFLICT', `รหัสทักษะ ${code} มีอยู่แล้ว`, [
          { field: 'code', reason: 'taken' },
        ]);
      }
      await this.skills.create({
        data: {
          code,
          name,
          category: dto.category?.trim() ?? '',
          sortOrder: dto.sort_order ?? 0,
          active: dto.active ?? true,
        },
      });
    }
    await this.audit.record({
      eventType: 'hr.skill.saved',
      companyId: actor.activeCompanyId,
      ...auditActor(actor),
      resourceType: 'hr_skill',
      resourceId: id ?? dto.code ?? '',
      after: { ...dto },
    });
    return this.skillCatalog(actor);
  }

  // --- helpers ---------------------------------------------------------------

  private async rowsFor(companyId: string, userIds: string[]) {
    const members = (await this.members.findMany({
      where: { companyId, userId: { in: userIds } },
      include: { user: { select: USER_SELECT } },
    })) as unknown as Member[];
    const [profiles, skills] = await Promise.all([
      this.profilesOf(companyId, userIds),
      this.skillsOf(userIds),
    ]);
    return members
      .map((member) =>
        view(member, profiles.get(member.user.id), skills.get(member.user.id)),
      )
      .sort((a, b) => a.displayName.localeCompare(b.displayName, 'th'));
  }

  private async requireMember(companyId: string, userId: string) {
    const member = (await this.members.findFirst({
      where: { companyId, userId },
      include: { user: { select: USER_SELECT } },
    })) as unknown as Member | null;
    if (!member) throw new AppError('NOT_FOUND', 'ไม่พบพนักงานที่ระบุ');
    return member;
  }

  private async profilesOf(companyId: string, userIds: string[]) {
    const rows = (await this.employees.findMany({
      where: { companyId, userId: { in: userIds } },
      include: { level: { select: { id: true, code: true, name: true } } },
    })) as unknown as Profile[];
    return new Map(rows.map((row) => [row.userId, row]));
  }

  private async skillsOf(userIds: string[]) {
    const rows = (await this.userSkills.findMany({
      where: { userId: { in: userIds }, deletedAt: null },
      include: {
        skill: { select: { id: true, code: true, name: true, category: true } },
      },
    })) as unknown as UserSkill[];
    const byUser = new Map<string, UserSkill[]>();
    for (const row of rows) {
      byUser.set(row.userId, [...(byUser.get(row.userId) ?? []), row]);
    }
    return byUser;
  }
}

const USER_SELECT = {
  id: true,
  displayName: true,
  email: true,
  employeeId: true,
  position: true,
  phone: true,
  extension: true,
  startWork: true,
  status: true,
  orgUnit: { select: { id: true, name: true } },
  supervisor: { select: { id: true, displayName: true } },
};

/** One person as the register shows them: directory facts + HR's. */
export function view(
  member: Member,
  profile: Profile | undefined,
  skills: UserSkill[] = [],
) {
  const today = thaiToday();
  const user = member.user;
  return {
    userId: user.id,
    displayName: user.displayName,
    email: user.email,
    employeeId: user.employeeId,
    position: user.position,
    phone: user.phone,
    extension: user.extension,
    startWork: day(user.startWork),
    accountStatus: user.status,
    orgUnit: user.orgUnit,
    supervisor: user.supervisor,
    profile: {
      saved: Boolean(profile),
      levelId: profile?.levelId ?? null,
      level: profile?.level ?? null,
      employmentType: profile?.employmentType ?? 'permanent',
      status: profile?.status ?? 'active',
      endDate: day(profile?.endDate ?? null),
      note: profile?.note ?? '',
    },
    skills: skills
      .map((row) => ({
        skillId: row.skillId,
        code: row.skill.code,
        name: row.skill.name,
        category: row.skill.category,
        proficiency: row.proficiency,
        certificate: row.certificate,
        certExpiresOn: day(row.certExpiresOn),
        certExpired: Boolean(
          row.certExpiresOn && day(row.certExpiresOn)! < today,
        ),
        note: row.note,
      }))
      .sort(
        (a, b) => b.proficiency - a.proficiency || a.name.localeCompare(b.name),
      ),
  };
}

type Row = ReturnType<typeof view>;

function isHr(actor: Principal): boolean {
  return (
    actor.permissions.includes('hr.employee.read') ||
    actor.permissions.includes('hr.employee.manage')
  );
}

/** CD-230 — what a supervisor sees: no employment terms, no notes. */
export function teamView(row: Row) {
  return {
    ...row,
    profile: {
      saved: row.profile.saved,
      levelId: row.profile.levelId,
      level: row.profile.level,
      status: row.profile.status,
    },
  };
}

/** CD-230 — what PM / Pre-Sales staff by: name, place, level, skills. */
export function staffView(row: Row) {
  return {
    userId: row.userId,
    displayName: row.displayName,
    position: row.position,
    orgUnit: row.orgUnit,
    level: row.profile.level,
    skills: row.skills.map((skill) => ({
      skillId: skill.skillId,
      name: skill.name,
      category: skill.category,
      proficiency: skill.proficiency,
      certExpired: skill.certExpired,
    })),
  };
}
