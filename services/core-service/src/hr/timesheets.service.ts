import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AppError,
  AuditWriter,
  auditActor,
  Principal,
  PrismaTransactionService,
} from '@request-management/share';
import { thaiToday } from '../crm/vendor-costs';
import { NotificationsService } from '../notifications/notifications.service';
import {
  HrEmployeeRepository,
  HrInternalActivityRepository,
  HrReportingRepository,
  HrTimesheetRepository,
  HrWorkRefsRepository,
  HrWorkTypeRepository,
} from './hr.repositories';
import { SaveTimesheetWeekDto } from './hr.dto';
import {
  type CleanLine,
  cleanWeek,
  dayTotals,
  LONG_DAY_HOURS,
  mandays,
  weekDays,
  weekStartOf,
} from './timesheet-rules';

const EDITABLE = ['draft', 'returned'];
const day = (value: Date) => value.toISOString().slice(0, 10);
const date = (value: string) => new Date(`${value}T00:00:00Z`);

interface SheetRow {
  id: string;
  companyId: string;
  userId: string;
  weekStart: Date;
  status: string;
  submittedAt: Date | null;
  decidedAt: Date | null;
  decidedBy: string | null;
  returnReason: string | null;
  lines: {
    workDate: Date;
    kind: string;
    projectId: string | null;
    projectTaskId: string | null;
    requestId: string | null;
    solutionId: string | null;
    internalCode: string | null;
    workTypeId: string;
    hours: Prisma.Decimal;
    billable: boolean;
    note: string;
  }[];
}

/**
 * CD-231 — Timesheet (part of CD-17 HR).
 *
 * Hours per day against a piece of work — a project (and optionally one of
 * its tasks), a service case (a request), Pre-Sales work (a Solution) or an
 * internal activity — each with HR's work type, so labour can be costed
 * (CD-234). A week is kept as a draft, submitted, then approved or returned
 * (with the reason) by the person's supervisor, anyone above them in the
 * reporting lines, or HR. Approved weeks are locked.
 *
 * Project and service time counts as billable unless marked otherwise;
 * Pre-Sales and internal time never does (Utilization, CD-235).
 */
@Injectable()
export class TimesheetsService {
  constructor(
    private readonly sheets: HrTimesheetRepository,
    private readonly refs: HrWorkRefsRepository,
    private readonly workTypes: HrWorkTypeRepository,
    private readonly activities: HrInternalActivityRepository,
    private readonly employees: HrEmployeeRepository,
    private readonly reporting: HrReportingRepository,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  /** What the caller can log time against. */
  async options(actor: Principal) {
    const companyId = actor.activeCompanyId;
    const memberOf = await this.refs.memberProjectIds(actor.userId);
    const [projects, workTypes, activities, requests, solutions] =
      await Promise.all([
        this.refs.projects({
          companyId,
          status: { in: ['active', 'on_hold'] },
          OR: [{ managerUserId: actor.userId }, { id: { in: memberOf } }],
        }),
        this.workTypes.findMany({
          where: { companyId, active: true },
          orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
          select: { id: true, code: true, name: true },
        }),
        this.activities.findMany({
          where: { active: true },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          select: { code: true, name: true },
        }),
        this.refs.requests({
          companyId,
          status: {
            in: ['submitted', 'in_progress', 'on_hold', 'pending_approval'],
          },
          OR: [
            { assigneeUserId: actor.userId },
            { receiverUserId: actor.userId },
          ],
        }),
        this.refs.solutions({ companyId }),
      ]);
    const tasks = await this.refs.tasks(projects.map((project) => project.id));
    const types = await this.refs.requestTypeNames([
      ...new Set(requests.map((request) => request.typeCode)),
    ]);
    return {
      projects: projects.map((project) => ({
        ...project,
        tasks: tasks
          .filter((task) => task.projectId === project.id)
          .map(({ id, seq, title, status }) => ({ id, seq, title, status })),
      })),
      requests: requests.map((request) => ({
        id: request.id,
        label: `${request.requestNo ?? 'ร่าง'} · ${types.get(request.typeCode) ?? request.typeCode}`,
      })),
      solutions: solutions.map((solution) => ({
        id: solution.id,
        label: `${solution.opportunity.opportunityCode} · ${solution.title}`,
      })),
      internal: activities,
      work_types: workTypes,
    };
  }

  /** The caller's week (an empty draft when nothing is saved yet). */
  async week(actor: Principal, anyDay: string) {
    const weekStart = weekStartOf(anyDay);
    const found = await this.findSheet(
      actor.activeCompanyId,
      actor.userId,
      weekStart,
    );
    return this.labelled(
      actor.activeCompanyId,
      this.view(found, weekStart, actor.userId),
    );
  }

  async saveWeek(actor: Principal, dto: SaveTimesheetWeekDto) {
    const companyId = actor.activeCompanyId;
    const weekStart = weekStartOf(dto.week_start);
    const existing = await this.findSheet(companyId, actor.userId, weekStart);
    if (existing && !EDITABLE.includes(existing.status)) {
      throw new AppError(
        'CONFLICT',
        existing.status === 'approved'
          ? 'สัปดาห์นี้อนุมัติแล้ว แก้ไม่ได้'
          : 'สัปดาห์นี้ส่งรออนุมัติอยู่ — รอผลหรือให้หัวหน้าตีกลับก่อน',
      );
    }
    const { lines, problems } = cleanWeek(dto.rows, weekStart, thaiToday());
    if (!problems.length)
      problems.push(...(await this.refProblems(companyId, lines)));
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'rows', reason })),
      );
    }
    await this.transactions.execute(async (prisma) => {
      const sheet = existing
        ? { id: existing.id }
        : await prisma.hrTimesheet.create({
            data: {
              companyId,
              userId: actor.userId,
              weekStart: date(weekStart),
            },
            select: { id: true },
          });
      // A draft's lines are replaced whole, as a quotation draft's are.
      await prisma.hrTimesheetLine.deleteMany({
        where: { timesheetId: sheet.id },
      });
      if (lines.length) {
        await prisma.hrTimesheetLine.createMany({
          data: lines.map((line) => ({
            ...line,
            timesheetId: sheet.id,
            workDate: date(line.workDate),
          })),
        });
      }
      await this.audit.record(
        {
          eventType: 'hr.timesheet.saved',
          companyId,
          ...auditActor(actor),
          resourceType: 'hr_timesheet',
          resourceId: sheet.id,
          after: {
            weekStart,
            lines: lines.length,
            hours: lines.reduce((sum, line) => sum + line.hours, 0),
          },
        },
        { prisma },
      );
    });
    return this.week(actor, weekStart);
  }

  async submit(actor: Principal, id: string) {
    const sheet = await this.requireSheet(actor.activeCompanyId, id);
    if (sheet.userId !== actor.userId) {
      throw new AppError('FORBIDDEN', 'ส่งได้เฉพาะ Timesheet ของตัวเอง');
    }
    if (!EDITABLE.includes(sheet.status)) {
      throw new AppError('CONFLICT', 'สัปดาห์นี้ส่งแล้ว');
    }
    if (!sheet.lines.length) {
      throw new AppError('VALIDATION_FAILED', 'ยังไม่ได้ลงเวลาในสัปดาห์นี้', [
        { field: 'lines', reason: 'empty' },
      ]);
    }
    await this.move(actor, sheet, ['draft', 'returned'], {
      status: 'submitted',
      submittedAt: new Date(),
      returnReason: null,
    });
    const supervisor = await this.refs.supervisorOf(sheet.userId);
    if (supervisor?.supervisorUserId) {
      await this.notifications.timesheetSubmitted(
        supervisor.supervisorUserId,
        sheet.companyId,
        { id: sheet.id, weekStart: day(sheet.weekStart) },
        supervisor.displayName,
        total(sheet),
      );
    }
    return this.findOne(actor, id);
  }

  /** Weeks waiting on the caller: submitted by anyone below them. */
  async pending(actor: Principal) {
    const below = await this.reporting.subordinatesOf(actor.userId);
    const rows = (await this.sheets.findMany({
      where: {
        companyId: actor.activeCompanyId,
        status: 'submitted',
        ...(isHrManager(actor) ? {} : { userId: { in: below } }),
      },
      include: { lines: true },
      orderBy: [{ weekStart: 'asc' }],
    })) as unknown as SheetRow[];
    const names = await this.refs.names([
      ...new Set(rows.map((row) => row.userId)),
    ]);
    return {
      items: rows.map((row) => ({
        id: row.id,
        userId: row.userId,
        name: names.get(row.userId) ?? row.userId,
        weekStart: day(row.weekStart),
        submittedAt: row.submittedAt,
        hours: total(row),
        billableHours: total(row, true),
      })),
    };
  }

  /** One week — its owner, anyone above them, or HR. */
  async findOne(actor: Principal, id: string) {
    const sheet = await this.requireSheet(actor.activeCompanyId, id);
    if (
      sheet.userId !== actor.userId &&
      !(await this.mayDecide(actor, sheet.userId))
    ) {
      throw new AppError('NOT_FOUND', 'ไม่พบ Timesheet ที่ระบุ');
    }
    return this.labelled(
      actor.activeCompanyId,
      this.view(sheet, day(sheet.weekStart), sheet.userId),
    );
  }

  async approve(actor: Principal, id: string) {
    const sheet = await this.decidable(actor, id);
    await this.move(actor, sheet, ['submitted'], {
      status: 'approved',
      decidedAt: new Date(),
      decidedBy: actor.userId,
    });
    return this.findOne(actor, id);
  }

  async returnSheet(actor: Principal, id: string, reason: string) {
    const why = reason.trim();
    if (!why) {
      throw new AppError('VALIDATION_FAILED', 'ต้องระบุเหตุผลที่ตีกลับ', [
        { field: 'reason', reason: 'required' },
      ]);
    }
    const sheet = await this.decidable(actor, id);
    await this.move(actor, sheet, ['submitted'], {
      status: 'returned',
      decidedAt: new Date(),
      decidedBy: actor.userId,
      returnReason: why,
    });
    await this.notifications.timesheetReturned(
      sheet.userId,
      sheet.companyId,
      { id: sheet.id, weekStart: day(sheet.weekStart) },
      why,
    );
    return this.findOne(actor, id);
  }

  /**
   * For PM (CD-190) and CD-234: a project's approved time, per person, day
   * and work type, with the person's HR level in this company.
   */
  async projectActuals(companyId: string, projectId: string) {
    const rows = (await this.sheets.findMany({
      where: {
        companyId,
        status: 'approved',
        lines: { some: { projectId } },
      },
      include: { lines: { where: { projectId } } },
    })) as unknown as SheetRow[];
    const levels = new Map(
      (
        (await this.employees.findMany({
          where: {
            companyId,
            userId: { in: [...new Set(rows.map((row) => row.userId))] },
          },
          select: { userId: true, levelId: true },
        })) as { userId: string; levelId: string | null }[]
      ).map((row) => [row.userId, row.levelId]),
    );
    const lines = rows.flatMap((row) =>
      row.lines.map((line) => ({
        userId: row.userId,
        levelId: levels.get(row.userId) ?? null,
        workTypeId: line.workTypeId,
        projectTaskId: line.projectTaskId,
        date: day(line.workDate),
        hours: Number(line.hours),
        billable: line.billable,
      })),
    );
    const hours = lines.reduce((sum, line) => sum + line.hours, 0);
    return { hours, mandays: mandays(hours), lines };
  }

  /**
   * CD-243 — time logged against service cases (requests), submitted or
   * approved: the job's time and materials, and its labour charge (approved
   * and billable only — the caller decides).
   */
  async serviceTime(companyId: string, requestIds: string[]) {
    if (!requestIds.length) return [];
    const rows = (await this.sheets.findMany({
      where: {
        companyId,
        status: { in: ['submitted', 'approved'] },
        lines: { some: { kind: 'service', requestId: { in: requestIds } } },
      },
      include: {
        lines: { where: { kind: 'service', requestId: { in: requestIds } } },
      },
    })) as unknown as SheetRow[];
    return rows.flatMap((row) =>
      row.lines.map((line) => ({
        userId: row.userId,
        requestId: line.requestId!,
        workTypeId: line.workTypeId,
        date: day(line.workDate),
        hours: Number(line.hours),
        billable: line.billable,
        approved: row.status === 'approved',
      })),
    );
  }

  // --- helpers ---------------------------------------------------------------

  private async findSheet(
    companyId: string,
    userId: string,
    weekStart: string,
  ) {
    return (await this.sheets.findFirst({
      where: { companyId, userId, weekStart: date(weekStart) },
      include: { lines: { orderBy: { workDate: 'asc' } } },
    })) as unknown as SheetRow | null;
  }

  private async requireSheet(companyId: string, id: string) {
    const sheet = (await this.sheets.findFirst({
      where: { id, companyId },
      include: { lines: { orderBy: { workDate: 'asc' } } },
    })) as unknown as SheetRow | null;
    if (!sheet) throw new AppError('NOT_FOUND', 'ไม่พบ Timesheet ที่ระบุ');
    return sheet;
  }

  private async mayDecide(actor: Principal, ownerId: string) {
    if (ownerId === actor.userId) return false;
    if (isHrManager(actor)) return true;
    return (await this.reporting.subordinatesOf(actor.userId)).includes(
      ownerId,
    );
  }

  private async decidable(actor: Principal, id: string) {
    const sheet = await this.requireSheet(actor.activeCompanyId, id);
    if (sheet.userId === actor.userId) {
      throw new AppError('FORBIDDEN', 'อนุมัติ Timesheet ของตัวเองไม่ได้');
    }
    if (!(await this.mayDecide(actor, sheet.userId))) {
      throw new AppError('NOT_FOUND', 'ไม่พบ Timesheet ที่ระบุ');
    }
    if (sheet.status !== 'submitted') {
      throw new AppError('CONFLICT', 'สัปดาห์นี้ไม่ได้รออนุมัติ');
    }
    return sheet;
  }

  private async move(
    actor: Principal,
    sheet: SheetRow,
    from: string[],
    data: Prisma.HrTimesheetUpdateManyMutationInput & {
      status: string;
      returnReason?: string | null;
    },
  ) {
    await this.transactions.execute(async (prisma) => {
      const moved = await prisma.hrTimesheet.updateMany({
        where: { id: sheet.id, status: { in: from } },
        data,
      });
      if (moved.count !== 1) {
        throw new AppError(
          'CONFLICT',
          'สถานะเปลี่ยนไปแล้ว — โหลดใหม่แล้วลองอีกครั้ง',
        );
      }
      await this.audit.record(
        {
          eventType: `hr.timesheet.${data.status}`,
          companyId: sheet.companyId,
          ...auditActor(actor),
          resourceType: 'hr_timesheet',
          resourceId: sheet.id,
          before: { status: sheet.status },
          after: {
            status: data.status,
            reason: data.returnReason ?? null,
          },
        },
        { prisma },
      );
    });
  }

  /** Everything a line points at must exist in this company and be usable. */
  private async refProblems(companyId: string, lines: CleanLine[]) {
    const problems: string[] = [];
    const ids = (pick: (line: CleanLine) => string | null) => [
      ...new Set(lines.map(pick).filter((id): id is string => Boolean(id))),
    ];
    const projectIds = ids((line) => line.projectId);
    const taskIds = ids((line) => line.projectTaskId);
    const [projects, tasks, requests, solutions, workTypes, activities] =
      await Promise.all([
        projectIds.length
          ? this.refs.projects({ companyId, id: { in: projectIds } })
          : Promise.resolve([] as { id: string }[]),
        projectIds.length
          ? this.refs.tasks(projectIds)
          : Promise.resolve([] as { id: string; projectId: string }[]),
        ids((line) => line.requestId).length
          ? this.refs.requests({
              companyId,
              id: { in: ids((line) => line.requestId) },
            })
          : Promise.resolve([] as { id: string }[]),
        ids((line) => line.solutionId).length
          ? this.refs.solutions({
              companyId,
              id: { in: ids((line) => line.solutionId) },
            })
          : Promise.resolve([] as { id: string }[]),
        this.workTypes.findMany({
          where: {
            companyId,
            active: true,
            id: { in: ids((line) => line.workTypeId) },
          },
          select: { id: true },
        }) as Promise<{ id: string }[]>,
        this.activities.findMany({
          where: {
            active: true,
            code: { in: ids((line) => line.internalCode) },
          },
          select: { code: true },
        }) as Promise<{ code: string }[]>,
      ]);
    const has = (rows: { id: string }[], id: string) =>
      rows.some((row) => row.id === id);
    for (const line of lines) {
      if (line.projectId && !has(projects, line.projectId))
        problems.push('ไม่พบโครงการที่เลือก');
      if (
        line.projectTaskId &&
        !tasks.some(
          (task) =>
            task.id === line.projectTaskId && task.projectId === line.projectId,
        )
      )
        problems.push('งานย่อยไม่อยู่ในโครงการที่เลือก');
      if (line.requestId && !has(requests, line.requestId))
        problems.push('ไม่พบเคสบริการที่เลือก');
      if (line.solutionId && !has(solutions, line.solutionId))
        problems.push('ไม่พบ Solution ที่เลือก');
      if (!has(workTypes, line.workTypeId))
        problems.push('ประเภทงานไม่ถูกต้องหรือเลิกใช้แล้ว');
      if (
        line.internalCode &&
        !activities.some((row) => row.code === line.internalCode)
      )
        problems.push('งานภายในไม่ถูกต้องหรือเลิกใช้แล้ว');
    }
    void taskIds;
    return [...new Set(problems)];
  }

  /** Names for every id on the week, so a supervisor can read it too. */
  private async labelled<T extends { lines: ViewLine[] }>(
    companyId: string,
    view: T,
  ) {
    const ids = (pick: (line: ViewLine) => string | null) => [
      ...new Set(view.lines.map(pick).filter((id): id is string => !!id)),
    ];
    const projectIds = ids((line) => line.projectId);
    const [projects, tasks, requests, solutions, workTypes, activities] =
      await Promise.all([
        projectIds.length
          ? this.refs.projects({ companyId, id: { in: projectIds } })
          : Promise.resolve(
              [] as { id: string; projectNo: string; name: string }[],
            ),
        projectIds.length
          ? this.refs.tasks(projectIds)
          : Promise.resolve([] as { id: string; seq: number; title: string }[]),
        this.refs.requests({
          companyId,
          id: { in: ids((line) => line.requestId) },
        }),
        this.refs.solutions({
          companyId,
          id: { in: ids((line) => line.solutionId) },
        }),
        this.workTypes.findMany({
          where: { companyId },
          select: { id: true, name: true },
        }),
        this.activities.findMany({ select: { code: true, name: true } }),
      ]);
    const types = await this.refs.requestTypeNames([
      ...new Set(requests.map((request) => request.typeCode)),
    ]);
    const labels: Record<string, string> = {};
    for (const project of projects)
      labels[project.id] = `${project.projectNo} · ${project.name}`;
    for (const task of tasks) labels[task.id] = `#${task.seq} ${task.title}`;
    for (const request of requests)
      labels[request.id] =
        `${request.requestNo ?? 'ร่าง'} · ${types.get(request.typeCode) ?? request.typeCode}`;
    for (const solution of solutions)
      labels[solution.id] =
        `${solution.opportunity.opportunityCode} · ${solution.title}`;
    for (const type of workTypes) labels[type.id] = type.name;
    for (const activity of activities)
      labels[`internal:${activity.code}`] = activity.name;
    return { ...view, labels };
  }

  private view(sheet: SheetRow | null, weekStart: string, userId: string) {
    const lines = (sheet?.lines ?? []).map((line) => ({
      workDate: day(line.workDate),
      kind: line.kind,
      projectId: line.projectId,
      projectTaskId: line.projectTaskId,
      requestId: line.requestId,
      solutionId: line.solutionId,
      internalCode: line.internalCode,
      workTypeId: line.workTypeId,
      hours: Number(line.hours),
      billable: line.billable,
      note: line.note,
    }));
    const totals = dayTotals(lines);
    return {
      id: sheet?.id ?? null,
      userId,
      weekStart,
      days: weekDays(weekStart),
      status: sheet?.status ?? 'draft',
      editable: !sheet || EDITABLE.includes(sheet.status),
      submittedAt: sheet?.submittedAt ?? null,
      decidedAt: sheet?.decidedAt ?? null,
      decidedBy: sheet?.decidedBy ?? null,
      returnReason: sheet?.returnReason ?? null,
      lines,
      totals,
      hours: lines.reduce((sum, line) => sum + line.hours, 0),
      billableHours: lines
        .filter((line) => line.billable)
        .reduce((sum, line) => sum + line.hours, 0),
      longDays: Object.entries(totals)
        .filter(([, hours]) => hours > LONG_DAY_HOURS)
        .map(([dayOf]) => dayOf),
    };
  }
}

type ViewLine = {
  projectId: string | null;
  projectTaskId: string | null;
  requestId: string | null;
  solutionId: string | null;
};

function isHrManager(actor: Principal) {
  return actor.permissions.includes('hr.employee.manage');
}

function total(sheet: SheetRow, billableOnly = false) {
  return sheet.lines
    .filter((line) => !billableOnly || line.billable)
    .reduce((sum, line) => sum + Number(line.hours), 0);
}
