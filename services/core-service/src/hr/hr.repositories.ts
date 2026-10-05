import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
} from '@request-management/share';

/** CD-207 — HR's levels, work types and labour cost rates. */

@Injectable()
export class HrLevelRepository extends BaseRepository<
  PrismaService['hrLevel']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.hrLevel;
  }
}

@Injectable()
export class HrWorkTypeRepository extends BaseRepository<
  PrismaService['hrWorkType']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.hrWorkType;
  }
}

@Injectable()
export class HrLaborRateRepository extends BaseRepository<
  PrismaService['hrLaborRate']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.hrLaborRate;
  }
}

/** CD-229 — HR's profile of a person in one company. */
@Injectable()
export class HrEmployeeRepository extends BaseRepository<
  PrismaService['hrEmployee']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.hrEmployee;
  }
}

/** CD-229 — the skill catalog, shared by every company. */
@Injectable()
export class HrSkillRepository extends BaseRepository<
  PrismaService['hrSkill']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.hrSkill;
  }
}

/** CD-229 — a person's skills. */
@Injectable()
export class HrUserSkillRepository extends BaseRepository<
  PrismaService['hrUserSkill']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.hrUserSkill;
  }
}

/**
 * CD-229 — who works for a company: its memberships with the user directory
 * (LDAP-synced) — the register lists these, it never creates people.
 */
@Injectable()
export class HrMemberRepository extends BaseRepository<
  PrismaService['userCompany']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.userCompany;
  }
}

/** CD-230 — the reporting lines of the user directory (who reports to whom). */
@Injectable()
export class HrReportingRepository extends BaseRepository<
  PrismaService['user']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.user;
  }

  /** Everyone below `userId`, every level down (cycles are cut). */
  async subordinatesOf(userId: string): Promise<string[]> {
    const seen = new Set<string>([userId]);
    let frontier = [userId];
    while (frontier.length) {
      const rows = (await this.findMany({
        where: { supervisorUserId: { in: frontier } },
        select: { id: true },
      })) as { id: string }[];
      frontier = rows.map((row) => row.id).filter((id) => !seen.has(id));
      frontier.forEach((id) => seen.add(id));
    }
    seen.delete(userId);
    return [...seen];
  }
}

/** CD-231 — weekly timesheets and their lines. */
@Injectable()
export class HrTimesheetRepository extends BaseRepository<
  PrismaService['hrTimesheet']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.hrTimesheet;
  }
}

@Injectable()
export class HrTimesheetLineRepository extends BaseRepository<
  PrismaService['hrTimesheetLine']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.hrTimesheetLine;
  }
}

/** CD-231 — internal (non-billable) activities time can be logged against. */
@Injectable()
export class HrInternalActivityRepository extends BaseRepository<
  PrismaService['hrInternalActivity']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.hrInternalActivity;
  }
}

/**
 * CD-231 — the work a timesheet line can point at, read only: projects and
 * their tasks (PM), requests (service cases), Solutions (Pre-Sales).
 */
@Injectable()
export class HrWorkRefsRepository {
  constructor(private readonly prisma: PrismaService) {}

  projects(where: Record<string, unknown>) {
    return this.prisma.project.findMany({
      where,
      select: { id: true, projectNo: true, name: true, status: true },
      orderBy: { projectNo: 'desc' },
      take: 200,
    });
  }

  tasks(projectIds: string[]) {
    return this.prisma.projectTask.findMany({
      where: { projectId: { in: projectIds } },
      select: {
        id: true,
        projectId: true,
        seq: true,
        title: true,
        status: true,
      },
      orderBy: [{ projectId: 'asc' }, { seq: 'asc' }],
    });
  }

  memberProjectIds(userId: string) {
    return this.prisma.projectMember
      .findMany({ where: { userId }, select: { projectId: true } })
      .then((rows) => rows.map((row) => row.projectId));
  }

  requests(where: Record<string, unknown>) {
    return this.prisma.request.findMany({
      where,
      select: {
        id: true,
        requestNo: true,
        typeCode: true,
        status: true,
        contactCompany: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  requestTypeNames(codes: string[]) {
    return this.prisma.requestType
      .findMany({
        where: { code: { in: codes } },
        select: { code: true, name: true },
      })
      .then((rows) => new Map(rows.map((row) => [row.code, row.name])));
  }

  solutions(where: Record<string, unknown>) {
    return this.prisma.solution.findMany({
      where,
      select: {
        id: true,
        title: true,
        opportunity: { select: { opportunityCode: true } },
      },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });
  }

  supervisorOf(userId: string) {
    return this.prisma.user
      .findUnique({
        where: { id: userId },
        select: { supervisorUserId: true, displayName: true },
      })
      .then((row) => row ?? null);
  }

  /** CD-232 — a project with who runs it. */
  project(companyId: string, id: string) {
    return this.prisma.project.findFirst({
      where: { id, companyId },
      select: {
        id: true,
        projectNo: true,
        name: true,
        status: true,
        managerUserId: true,
      },
    });
  }

  /** CD-232 — a project's manager and team. */
  projectPeople(projectId: string) {
    return this.prisma.projectMember
      .findMany({ where: { projectId }, select: { userId: true } })
      .then((rows) => rows.map((row) => row.userId));
  }

  /** CD-233 — projects with what plan-vs-actual needs. */
  mandayProjects(where: Record<string, unknown>) {
    return this.prisma.project.findMany({
      where,
      select: {
        id: true,
        companyId: true,
        projectNo: true,
        name: true,
        status: true,
        managerUserId: true,
        solutionVersionId: true,
        startOn: true,
        endOn: true,
        updatedAt: true,
      },
      orderBy: { projectNo: 'desc' },
      take: 300,
    });
  }

  /** CD-233 — each project's latest locked budget. */
  async lockedBudgets(projectIds: string[]) {
    if (!projectIds.length)
      return new Map<string, { versionNo: number; lines: unknown }>();
    const rows = await this.prisma.projectBudget.findMany({
      where: { projectId: { in: projectIds }, status: 'locked' },
      select: { projectId: true, versionNo: true, lines: true },
      orderBy: { versionNo: 'desc' },
    });
    const out = new Map<string, { versionNo: number; lines: unknown }>();
    for (const row of rows)
      if (!out.has(row.projectId))
        out.set(row.projectId, { versionNo: row.versionNo, lines: row.lines });
    return out;
  }

  /** CD-233 — the labour lines of Solution versions. */
  async solutionLabor(versionIds: string[]) {
    if (!versionIds.length) return new Map<string, unknown>();
    const rows = await this.prisma.solutionVersion.findMany({
      where: { id: { in: versionIds } },
      select: { id: true, labor: true },
    });
    return new Map(rows.map((row) => [row.id, row.labor as unknown]));
  }

  /** CD-233 — approved timesheet hours per project. */
  async approvedHours(companyId: string, projectIds: string[]) {
    if (!projectIds.length) return new Map<string, number>();
    const rows = await this.prisma.hrTimesheetLine.groupBy({
      by: ['projectId'],
      where: {
        projectId: { in: projectIds },
        timesheet: { companyId, status: 'approved' },
      },
      _sum: { hours: true },
    });
    return new Map(
      rows.map((row) => [row.projectId ?? '', Number(row._sum.hours ?? 0)]),
    );
  }

  /** CD-233 — who in a company holds a permission through an active role. */
  holdersOf(companyId: string, permission: string) {
    return this.prisma.userRole
      .findMany({
        where: {
          companyId,
          role: {
            active: true,
            permissions: { some: { permissionCode: permission } },
          },
        },
        select: { userId: true },
      })
      .then((rows) => [...new Set(rows.map((row) => row.userId))]);
  }

  /** CD-233 — level and work type codes by id. */
  async hrCodes(companyId: string) {
    const [levels, workTypes] = await Promise.all([
      this.prisma.hrLevel.findMany({
        where: { companyId },
        select: { id: true, code: true, name: true },
      }),
      this.prisma.hrWorkType.findMany({
        where: { companyId },
        select: { id: true, code: true, name: true },
      }),
    ]);
    return { levels, workTypes };
  }

  /** CD-234 — requests by id, any number (no paging). */
  requestsByIds(companyId: string, ids: string[]) {
    return this.prisma.request.findMany({
      where: { companyId, id: { in: ids } },
      select: {
        id: true,
        requestNo: true,
        typeCode: true,
        status: true,
        contactCompany: true,
      },
    });
  }

  names(ids: string[]) {
    return this.prisma.user
      .findMany({
        where: { id: { in: ids } },
        select: { id: true, displayName: true },
      })
      .then((rows) => new Map(rows.map((row) => [row.id, row.displayName])));
  }
}

/** CD-232 — the company's kinds of leave and their yearly allowance. */
@Injectable()
export class HrLeaveTypeRepository extends BaseRepository<
  PrismaService['hrLeaveType']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.hrLeaveType;
  }
}

/** CD-232 — one person's allowance for a year, where HR set it. */
@Injectable()
export class HrLeaveEntitlementRepository extends BaseRepository<
  PrismaService['hrLeaveEntitlement']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.hrLeaveEntitlement;
  }
}

/** CD-232 — leave requests. */
@Injectable()
export class HrLeaveRepository extends BaseRepository<
  PrismaService['hrLeave']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.hrLeave;
  }
}

/** CD-232 — people booked onto projects. */
@Injectable()
export class HrBookingRepository extends BaseRepository<
  PrismaService['hrBooking']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.hrBooking;
  }
}

/** CD-232 — the company's working weekdays and holidays (SLA's calendar). */
@Injectable()
export class HrCalendarRepository extends BaseRepository<
  PrismaService['holidayCalendar']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.holidayCalendar;
  }
}

/** CD-233 — the steps of plan-vs-actual already sent. */
@Injectable()
export class HrMandayAlertRepository extends BaseRepository<
  PrismaService['hrMandayAlert']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.hrMandayAlert;
  }
}
