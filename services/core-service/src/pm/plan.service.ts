import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  AppError,
  AuditWriter,
  auditActor,
  Principal,
  PrismaTransactionService,
} from '@request-management/share';
import { CompanyMemberRepository } from '../access/company-member.repository';
import { bangkokDay } from '../crm/kyc-rules';
import { readDeliverables } from '../presales/solution-rules';
import { NotificationsService } from '../notifications/notifications.service';
import {
  PlanPreviewDto,
  SavePredecessorsDto,
  SaveTaskDto,
} from './dto/project.dto';
import { matchDeliverable } from './milestone-rules';
import {
  DEFAULT_WORK_CALENDAR,
  linkProblems,
  MAX_TASKS,
  milestoneForecast,
  schedulePlan,
  scheduleShifts,
  slippedMilestones,
  wbsCodes,
  wouldNest,
  type PlanLink,
  type WorkCalendar,
} from './plan-rules';
import {
  ProjectMilestoneRepository,
  ProjectRepository,
  ProjectTaskLinkRepository,
  ProjectTaskRepository,
  WorkCalendarRepository,
} from './project.repositories';
import { ProjectsService } from './projects.service';

/** A deliverable drawn into the plan starts as a week of work. */
const DRAWN_DURATION_DAYS = 5;

interface TaskRow {
  id: string;
  parentId: string | null;
  seq: number;
  title: string;
  description: string | null;
  ownerUserId: string | null;
  durationDays: number;
  milestoneId: string | null;
  status: string;
  milestone: { id: string; title: string; status: string } | null;
}

const TASK_SELECT = {
  id: true,
  parentId: true,
  seq: true,
  title: true,
  description: true,
  ownerUserId: true,
  durationDays: true,
  milestoneId: true,
  status: true,
  milestone: { select: { id: true, title: true, status: true } },
} as const;

/**
 * CD-177 วางแผนโครงการ — the work breakdown: tasks under tasks, each piece
 * of work with an owner and a number of working days, and which must finish
 * before which. Dates are worked out, not typed: from the project's start,
 * the company's working calendar and the links — with each task's float,
 * the critical path CD-178 draws.
 *
 * Who: whoever sees the project reads the plan; `pm.project.manage` or the
 * project's manager changes it.
 */
@Injectable()
export class PlanService {
  constructor(
    private readonly projects: ProjectsService,
    private readonly projectRows: ProjectRepository,
    private readonly tasks: ProjectTaskRepository,
    private readonly links: ProjectTaskLinkRepository,
    private readonly milestones: ProjectMilestoneRepository,
    private readonly calendars: WorkCalendarRepository,
    private readonly people: CompanyMemberRepository,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  async view(projectId: string, actor: Principal) {
    const { project, canEdit } = await this.projects.access(projectId, actor);
    const [rows, links, start, calendar, milestones] = await Promise.all([
      this.taskRows(projectId),
      this.linkRows(projectId),
      this.startOf(projectId),
      this.calendarOf(project.companyId),
      this.milestoneRows(projectId),
    ]);
    const codes = wbsCodes(rows);
    const problems = linkProblems(rows, links, codes);
    const plan = schedulePlan(rows, links, start, calendar);
    const live = rows.filter((row) => row.status !== 'cancelled');
    const summaries = new Set(
      live.map((row) => row.parentId).filter((id): id is string => Boolean(id)),
    );
    const names = await this.displayNames(rows.map((row) => row.ownerUserId));
    const byCode = (id: string) =>
      (codes.get(id) ?? '')
        .split('.')
        .map((part) => part.padStart(4, '0'))
        .join('.');
    return {
      canEdit,
      projectStart: start,
      finish: plan?.finish ?? null,
      problems,
      // CD-178 — when each milestone is now expected, against its due day
      milestones: this.forecastOf(milestones, rows, plan?.tasks ?? null),
      tasks: live
        .sort((a, b) => byCode(a.id).localeCompare(byCode(b.id)))
        .map((row) => {
          const dates = plan?.tasks.get(row.id) ?? null;
          return {
            id: row.id,
            parentId: row.parentId,
            seq: row.seq,
            wbs: codes.get(row.id) ?? '',
            title: row.title,
            description: row.description,
            ownerUserId: row.ownerUserId,
            ownerName: row.ownerUserId
              ? (names.get(row.ownerUserId) ?? null)
              : null,
            durationDays: row.durationDays,
            summary: summaries.has(row.id),
            milestone: row.milestone,
            start: dates?.start ?? null,
            finish: dates?.finish ?? null,
            floatDays: dates?.floatDays ?? null,
            critical: dates?.critical ?? false,
            predecessors: links
              .filter((link) => link.successorId === row.id)
              .map((link) => ({
                taskId: link.predecessorId,
                wbs: codes.get(link.predecessorId) ?? '',
                lagDays: link.lagDays,
              })),
          };
        }),
    };
  }

  async create(projectId: string, dto: SaveTaskDto, actor: Principal) {
    const { project } = await this.editable(projectId, actor);
    const title = dto.title?.trim();
    if (!title) {
      throw new AppError('VALIDATION_FAILED', 'ต้องระบุชื่องาน', [
        { field: 'title', reason: 'required' },
      ]);
    }
    const count = await this.tasks.count({ where: { projectId } });
    if (count >= MAX_TASKS) {
      throw new AppError(
        'VALIDATION_FAILED',
        `งานมีได้ไม่เกิน ${MAX_TASKS} รายการ`,
      );
    }
    const parentId = dto.parent_id ?? null;
    if (parentId) await this.assertParent(projectId, parentId);
    await this.checkRefs(project.companyId, projectId, dto);
    const task = await this.transactions.execute(async (prisma) => {
      const last = (await this.tasks.findFirst(
        {
          where: { projectId, parentId },
          orderBy: { seq: 'desc' },
          select: { seq: true },
        },
        { prisma },
      )) as { seq: number } | null;
      const created = (await this.tasks.create(
        {
          data: {
            companyId: project.companyId,
            projectId,
            parentId,
            seq: (last?.seq ?? 0) + 1,
            title,
            description: dto.description?.trim() || null,
            ownerUserId: dto.owner_user_id ?? null,
            durationDays: dto.duration_days ?? 1,
            milestoneId: dto.milestone_id ?? null,
            createdBy: actor.userId,
          },
          select: { id: true },
        },
        { prisma },
      )) as { id: string };
      await this.record(
        prisma,
        project.companyId,
        actor,
        'pm.task.created',
        created.id,
        {
          projectId,
          title,
          parentId,
        },
      );
      return created;
    });
    return { ...(await this.view(projectId, actor)), taskId: task.id };
  }

  async update(
    projectId: string,
    taskId: string,
    dto: SaveTaskDto,
    actor: Principal,
  ) {
    const { project } = await this.editable(projectId, actor);
    const current = await this.requireTask(projectId, taskId);
    await this.checkRefs(project.companyId, projectId, dto);
    const forecast = await this.forecastNow(projectId, project.companyId);
    const moving =
      dto.parent_id !== undefined &&
      (dto.parent_id ?? null) !== current.parentId;
    const parentId = moving ? (dto.parent_id ?? null) : current.parentId;
    if (moving) {
      const all = await this.taskRows(projectId);
      if (parentId && wouldNest(all, taskId, parentId)) {
        throw new AppError(
          'VALIDATION_FAILED',
          'ย้ายงานไปอยู่ใต้งานย่อยของตัวเองไม่ได้',
        );
      }
      if (parentId) await this.assertParent(projectId, parentId);
    }
    await this.transactions.execute(async (prisma) => {
      const siblings = (await this.tasks.findMany(
        {
          where: { projectId, parentId, id: { not: taskId } },
          orderBy: { seq: 'asc' },
          select: { id: true },
        },
        { prisma },
      )) as { id: string }[];
      const repositioning = moving || dto.position !== undefined;
      if (repositioning) {
        const at = Math.min(
          Math.max((dto.position ?? siblings.length + 1) - 1, 0),
          siblings.length,
        );
        const order = [...siblings.map((row) => row.id)];
        order.splice(at, 0, taskId);
        for (const [index, id] of order.entries()) {
          if (id !== taskId) {
            await this.tasks.update(
              { where: { id }, data: { seq: index + 1 } },
              { prisma },
            );
          }
        }
        dto.position = at + 1;
      }
      await this.tasks.update(
        {
          where: { id: taskId },
          data: {
            ...(dto.title !== undefined ? { title: dto.title.trim() } : {}),
            ...(dto.description !== undefined
              ? { description: dto.description.trim() || null }
              : {}),
            ...(dto.owner_user_id !== undefined
              ? { ownerUserId: dto.owner_user_id }
              : {}),
            ...(dto.duration_days !== undefined
              ? { durationDays: dto.duration_days }
              : {}),
            ...(dto.milestone_id !== undefined
              ? { milestoneId: dto.milestone_id }
              : {}),
            ...(repositioning ? { parentId, seq: dto.position } : {}),
            updatedBy: actor.userId,
          },
        },
        { prisma },
      );
      await this.record(
        prisma,
        project.companyId,
        actor,
        'pm.task.updated',
        taskId,
        {
          before: {
            title: current.title,
            parentId: current.parentId,
            durationDays: current.durationDays,
            ownerUserId: current.ownerUserId,
          },
          after: { ...dto },
        },
      );
    });
    await this.tellSlips(projectId, project.companyId, forecast, actor);
    return this.view(projectId, actor);
  }

  /** Cancelled with everything under it; the plan is dated without them. */
  async cancel(projectId: string, taskId: string, actor: Principal) {
    const { project } = await this.editable(projectId, actor);
    const current = await this.requireTask(projectId, taskId);
    const all = await this.taskRows(projectId);
    const under = new Set([taskId]);
    for (let grew = true; grew;) {
      grew = false;
      for (const row of all) {
        if (row.parentId && under.has(row.parentId) && !under.has(row.id)) {
          under.add(row.id);
          grew = true;
        }
      }
    }
    await this.transactions.execute(async (prisma) => {
      await prisma.projectTask.updateMany({
        where: { id: { in: [...under] } },
        data: { status: 'cancelled', updatedBy: actor.userId },
      });
      await this.record(
        prisma,
        project.companyId,
        actor,
        'pm.task.cancelled',
        taskId,
        {
          title: current.title,
          tasks: [...under],
        },
      );
    });
    return this.view(projectId, actor);
  }

  /** The work that must finish before this task starts — replaced whole. */
  async setPredecessors(
    projectId: string,
    taskId: string,
    dto: SavePredecessorsDto,
    actor: Principal,
  ) {
    const { project } = await this.editable(projectId, actor);
    await this.requireTask(projectId, taskId);
    const forecast = await this.forecastNow(projectId, project.companyId);
    const all = await this.taskRows(projectId);
    const known = new Set(
      all.filter((row) => row.status !== 'cancelled').map((row) => row.id),
    );
    const wanted: PlanLink[] = [];
    for (const item of dto.predecessors) {
      if (item.task_id === taskId) {
        throw new AppError('VALIDATION_FAILED', 'งานต้องเสร็จก่อนตัวเองไม่ได้');
      }
      if (!known.has(item.task_id)) {
        throw new AppError(
          'VALIDATION_FAILED',
          'ไม่พบงานก่อนหน้านี้ในแผนโครงการ',
          [{ field: 'predecessors', reason: item.task_id }],
        );
      }
      if (!wanted.some((link) => link.predecessorId === item.task_id)) {
        wanted.push({
          predecessorId: item.task_id,
          successorId: taskId,
          lagDays: item.lag_days ?? 0,
        });
      }
    }
    const others = (await this.linkRows(projectId)).filter(
      (link) => link.successorId !== taskId,
    );
    const problems = linkProblems(all, [...others, ...wanted]);
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'predecessors', reason })),
      );
    }
    await this.transactions.execute(async (prisma) => {
      await prisma.projectTaskLink.deleteMany({
        where: { successorId: taskId },
      });
      if (wanted.length) {
        await prisma.projectTaskLink.createMany({ data: wanted });
      }
      await this.record(
        prisma,
        project.companyId,
        actor,
        'pm.task.linked',
        taskId,
        {
          predecessors: wanted.map((link) => ({
            taskId: link.predecessorId,
            lagDays: link.lagDays,
          })),
        },
      );
    });
    await this.tellSlips(projectId, project.companyId, forecast, actor);
    return this.view(projectId, actor);
  }

  /**
   * The first breakdown: one task per deliverable of the baseline not yet
   * in the plan, tied to the milestone of the same name when there is one.
   */
  async fromDeliverables(projectId: string, actor: Principal) {
    const { project } = await this.editable(projectId, actor);
    const [detail, existing, milestones] = await Promise.all([
      this.projects.detail(projectId, actor),
      this.taskRows(projectId),
      this.milestones.findMany({
        where: { projectId, status: { not: 'cancelled' } },
        orderBy: { seq: 'asc' },
        select: { id: true, title: true },
      }) as Promise<{ id: string; title: string }[]>,
    ]);
    const baseline = detail.baseline as { scope?: { deliverables?: unknown } };
    const taken = new Set(
      existing
        .filter((row) => row.status !== 'cancelled')
        .map((row) => row.title.trim()),
    );
    const drafts = readDeliverables(baseline?.scope?.deliverables).filter(
      (item) => !taken.has(item.title.trim()),
    );
    if (!drafts.length) {
      throw new AppError(
        'CONFLICT',
        'ไม่มีสิ่งส่งมอบที่ยังไม่อยู่ในแผน — ฐานตั้งต้นไม่มีสิ่งส่งมอบ หรือสร้างครบแล้ว',
      );
    }
    await this.transactions.execute(async (prisma) => {
      const last = (await this.tasks.findFirst(
        {
          where: { projectId, parentId: null },
          orderBy: { seq: 'desc' },
          select: { seq: true },
        },
        { prisma },
      )) as { seq: number } | null;
      let seq = last?.seq ?? 0;
      for (const item of drafts) {
        const milestone = milestones.find((row) =>
          matchDeliverable(row.title, [item]),
        );
        await this.tasks.create(
          {
            data: {
              companyId: project.companyId,
              projectId,
              seq: ++seq,
              title: item.title,
              description: item.description?.trim() || null,
              durationDays: DRAWN_DURATION_DAYS,
              milestoneId: milestone?.id ?? null,
              createdBy: actor.userId,
            },
          },
          { prisma },
        );
      }
      await this.record(
        prisma,
        project.companyId,
        actor,
        'pm.task.from_deliverables',
        projectId,
        {
          tasks: drafts.map((item) => item.title),
        },
      );
    });
    return this.view(projectId, actor);
  }

  /**
   * CD-178 — what a change to one task would move, before it is saved:
   * the tasks whose dates change, the project's end, and each milestone's
   * forecast against its due day.
   */
  async preview(projectId: string, dto: PlanPreviewDto, actor: Principal) {
    const { project } = await this.editable(projectId, actor);
    const [rows, links, start, calendar, milestones] = await Promise.all([
      this.taskRows(projectId),
      this.linkRows(projectId),
      this.startOf(projectId),
      this.calendarOf(project.companyId),
      this.milestoneRows(projectId),
    ]);
    if (!rows.some((row) => row.id === dto.task_id)) {
      throw new AppError('NOT_FOUND', 'ไม่พบงานที่ระบุ');
    }
    const changedRows = rows.map((row) =>
      row.id === dto.task_id && dto.duration_days !== undefined
        ? { ...row, durationDays: dto.duration_days }
        : row,
    );
    const changedLinks = dto.predecessors
      ? [
          ...links.filter((link) => link.successorId !== dto.task_id),
          ...dto.predecessors.map((item) => ({
            predecessorId: item.task_id,
            successorId: dto.task_id,
            lagDays: item.lag_days ?? 0,
          })),
        ]
      : links;
    const codes = wbsCodes(rows);
    const problems = linkProblems(changedRows, changedLinks, codes);
    const before = schedulePlan(rows, links, start, calendar);
    const after = problems.length
      ? null
      : schedulePlan(changedRows, changedLinks, start, calendar);
    const titleOf = new Map(rows.map((row) => [row.id, row.title]));
    const forecastBefore = this.forecastOf(
      milestones,
      rows,
      before?.tasks ?? null,
    );
    const forecastAfter = this.forecastOf(
      milestones,
      changedRows,
      after?.tasks ?? null,
    );
    return {
      problems,
      finish: { from: before?.finish ?? null, to: after?.finish ?? null },
      moved:
        before && after
          ? scheduleShifts(before.tasks, after.tasks).map((shift) => ({
              ...shift,
              wbs: codes.get(shift.id) ?? '',
              title: titleOf.get(shift.id) ?? '',
            }))
          : [],
      milestones: forecastAfter
        .map((row) => ({
          ...row,
          from:
            forecastBefore.find((item) => item.id === row.id)?.forecast ?? null,
        }))
        .filter((row) => row.from !== row.forecast),
    };
  }

  /**
   * CD-178 — after a change is saved: a milestone that unlocks a payment
   * and is now forecast later is told to the contract's owner (Sales) and
   * to Legal (`legal.contract.manage`), apart from whoever made the change.
   */
  private async tellSlips(
    projectId: string,
    companyId: string,
    before: Map<string, string>,
    actor: Principal,
  ) {
    const after = await this.forecastNow(projectId, companyId);
    const slipped = slippedMilestones(before, after);
    if (!slipped.length) return;
    const project = (await this.projectRows.findFirst({
      where: { id: projectId },
      select: {
        id: true,
        projectNo: true,
        name: true,
        contract: { select: { ownerUserId: true } },
        milestones: {
          where: {
            id: { in: slipped.map((row) => row.milestoneId) },
            status: 'planned',
          },
          select: {
            id: true,
            title: true,
            dueOn: true,
            installment: {
              select: { seq: true, label: true, dueOn: true },
            },
          },
        },
      },
    })) as {
      id: string;
      projectNo: string;
      name: string;
      contract: { ownerUserId: string };
      milestones: {
        id: string;
        title: string;
        dueOn: Date | null;
        installment: { seq: number; label: string; dueOn: Date | null } | null;
      }[];
    } | null;
    if (!project) return;
    const legal = (await this.people.findMany({
      where: {
        status: 'ACTIVE',
        roles: {
          some: {
            companyId,
            role: {
              permissions: {
                some: { permissionCode: 'legal.contract.manage' },
              },
            },
          },
        },
      },
      select: { id: true },
    })) as { id: string }[];
    const recipients = [
      ...new Set([project.contract.ownerUserId, ...legal.map((row) => row.id)]),
    ].filter((id) => id !== actor.userId);
    for (const slip of slipped) {
      const milestone = project.milestones.find(
        (row) => row.id === slip.milestoneId,
      );
      if (!milestone?.installment) continue;
      for (const userId of recipients) {
        await this.notifications
          .milestoneSlipped(userId, companyId, {
            project,
            milestone: milestone.title,
            from: slip.from,
            to: slip.to,
            installment: {
              seq: milestone.installment.seq,
              label: milestone.installment.label,
              dueOn: milestone.installment.dueOn
                ? milestone.installment.dueOn.toISOString().slice(0, 10)
                : null,
            },
          })
          .catch(() => undefined);
      }
    }
  }

  /** Each milestone's forecast as the plan stands now. */
  private async forecastNow(projectId: string, companyId: string) {
    const [rows, links, start, calendar] = await Promise.all([
      this.taskRows(projectId),
      this.linkRows(projectId),
      this.startOf(projectId),
      this.calendarOf(companyId),
    ]);
    const plan = schedulePlan(rows, links, start, calendar);
    return plan
      ? milestoneForecast(rows, plan.tasks)
      : new Map<string, string>();
  }

  private async milestoneRows(projectId: string) {
    return (await this.milestones.findMany({
      where: { projectId, status: { not: 'cancelled' } },
      orderBy: { seq: 'asc' },
      select: {
        id: true,
        title: true,
        status: true,
        dueOn: true,
        installment: { select: { seq: true, label: true, dueOn: true } },
      },
    })) as unknown as {
      id: string;
      title: string;
      status: string;
      dueOn: Date | null;
      installment: { seq: number; label: string; dueOn: Date | null } | null;
    }[];
  }

  private forecastOf(
    milestones: Awaited<ReturnType<PlanService['milestoneRows']>>,
    rows: readonly TaskRow[],
    schedule: ReadonlyMap<string, { finish: string }> | null,
  ) {
    const forecast = schedule
      ? milestoneForecast(rows, schedule as never)
      : new Map<string, string>();
    const day = (value: Date | null) =>
      value ? value.toISOString().slice(0, 10) : null;
    return milestones.map((row) => {
      const at = forecast.get(row.id) ?? null;
      const due = day(row.dueOn);
      const payDue = row.installment ? day(row.installment.dueOn) : null;
      return {
        id: row.id,
        title: row.title,
        status: row.status,
        dueOn: due,
        installment: row.installment
          ? {
              seq: row.installment.seq,
              label: row.installment.label,
              dueOn: payDue,
            }
          : null,
        forecast: at,
        late:
          row.status === 'planned' &&
          at !== null &&
          ((due !== null && at > due) || (payDue !== null && at > payDue)),
      };
    });
  }

  // --- helpers -------------------------------------------------------------------

  private async editable(projectId: string, actor: Principal) {
    const access = await this.projects.access(projectId, actor);
    if (!access.canEdit) {
      throw new AppError(
        'FORBIDDEN',
        'แก้แผนงานได้เฉพาะผู้จัดการโครงการ หรือผู้มีสิทธิ์จัดการโครงการ ขณะโครงการยังดำเนินอยู่',
      );
    }
    return access;
  }

  private async taskRows(projectId: string) {
    return (await this.tasks.findMany({
      where: { projectId },
      select: TASK_SELECT,
    })) as unknown as TaskRow[];
  }

  private async linkRows(projectId: string): Promise<PlanLink[]> {
    return await this.links.findMany({
      where: { successor: { projectId } },
      select: { predecessorId: true, successorId: true, lagDays: true },
    });
  }

  private async requireTask(projectId: string, taskId: string) {
    const row = (await this.tasks.findFirst({
      where: { id: taskId, projectId },
      select: TASK_SELECT,
    })) as unknown as TaskRow | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบงานที่ระบุ');
    if (row.status === 'cancelled') {
      throw new AppError('CONFLICT', 'งานนี้ถูกยกเลิกแล้ว');
    }
    return row;
  }

  /** A parent in this project, still open, and not itself linked (it would become a summary). */
  private async assertParent(projectId: string, parentId: string) {
    const parent = await this.requireTask(projectId, parentId);
    const linked = await this.links.count({
      where: {
        OR: [{ predecessorId: parent.id }, { successorId: parent.id }],
      },
    });
    if (linked) {
      throw new AppError(
        'VALIDATION_FAILED',
        `"${parent.title}" ผูกลำดับกับงานอื่นอยู่ — ถอดลำดับก่อนจึงแตกงานย่อยได้`,
      );
    }
  }

  /** The owner is a person of the company; the milestone one of this project. */
  private async checkRefs(
    companyId: string,
    projectId: string,
    dto: SaveTaskDto,
  ) {
    if (dto.owner_user_id) {
      const found = await this.people.count({
        where: { id: dto.owner_user_id, companies: { some: { companyId } } },
      });
      if (!found) {
        throw new AppError(
          'VALIDATION_FAILED',
          'ผู้รับผิดชอบไม่ได้อยู่ในบริษัทนี้',
          [{ field: 'owner_user_id', reason: 'not_found' }],
        );
      }
    }
    if (dto.milestone_id) {
      const found = await this.milestones.count({
        where: { id: dto.milestone_id, projectId },
      });
      if (!found) {
        throw new AppError('VALIDATION_FAILED', 'ไม่พบหมุดหมายนี้ในโครงการ', [
          { field: 'milestone_id', reason: 'not_found' },
        ]);
      }
    }
  }

  /** The project's first day: the contract's start, else the day it opened. */
  private async startOf(projectId: string) {
    const row = (await this.projectRows.findFirst({
      where: { id: projectId },
      select: { startOn: true, openedAt: true },
    })) as { startOn: Date | null; openedAt: Date } | null;
    if (row?.startOn) return row.startOn.toISOString().slice(0, 10);
    return bangkokDay(row?.openedAt ?? new Date());
  }

  private async calendarOf(companyId: string): Promise<WorkCalendar> {
    const row = (await this.calendars.findFirst({
      where: { companyId },
      select: { workingWeekdays: true, holidays: true },
    })) as { workingWeekdays: number[]; holidays: unknown } | null;
    if (!row) return DEFAULT_WORK_CALENDAR;
    return {
      workingWeekdays: row.workingWeekdays.length
        ? row.workingWeekdays
        : DEFAULT_WORK_CALENDAR.workingWeekdays,
      holidays: Array.isArray(row.holidays)
        ? row.holidays.filter((day): day is string => typeof day === 'string')
        : [],
    };
  }

  private record(
    prisma: unknown,
    companyId: string,
    actor: Principal,
    eventType: string,
    resourceId: string,
    after: Record<string, unknown>,
  ) {
    return this.audit.record(
      {
        eventType,
        companyId,
        ...auditActor(actor),
        resourceType:
          eventType === 'pm.task.from_deliverables'
            ? 'project'
            : 'project_task',
        resourceId,
        after: after as Prisma.InputJsonValue,
      },
      { prisma: prisma as never },
    );
  }

  private async displayNames(ids: (string | null)[]) {
    const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    if (!unique.length) return new Map<string, string>();
    const users = (await this.people.findMany({
      where: { id: { in: unique } },
      select: { id: true, displayName: true },
    })) as { id: string; displayName: string }[];
    return new Map(users.map((user) => [user.id, user.displayName]));
  }
}
