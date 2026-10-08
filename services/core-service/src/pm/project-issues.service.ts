import { Injectable, Logger } from '@nestjs/common';
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
import { NotificationsService } from '../notifications/notifications.service';
import { ChangeRequestsService } from './change-requests.service';
import { ResolveIssueDto, SaveIssueDto } from './dto/project.dto';
import {
  changeFromIssue,
  issueOverdue,
  issueProblems,
  resolveProblems,
} from './issue-rules';
import { IssueResolvedHooks } from './issue-hooks';
import {
  ProjectIssueRepository,
  ProjectTaskRepository,
} from './project.repositories';
import { ProjectsService } from './projects.service';

interface IssueRow {
  id: string;
  companyId: string;
  projectId: string;
  seq: number;
  title: string;
  description: string | null;
  severity: string;
  scheduleImpactDays: number;
  costImpact: Prisma.Decimal;
  ownerUserId: string;
  dueOn: Date;
  taskId: string | null;
  status: string;
  resolution: string | null;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  changeRequestId: string | null;
  kind: string;
  cause: string | null;
  kbmsStatus: string | null;
  kbmsRef: string | null;
  createdAt: Date;
}

const day = (value: Date | null) =>
  value ? value.toISOString().slice(0, 10) : null;

/**
 * CD-184 ปัญหาระหว่างทาง — problems met on the way: what each does to the
 * schedule and the cost, who fixes it by when, and how it was resolved.
 * One that changes what was sold becomes a change request (CD-185) with
 * its days and cost carried over.
 *
 * Who: whoever sees the project reads them; `pm.project.manage` or the
 * project's manager records and edits them; the issue's owner may resolve
 * it.
 */
@Injectable()
export class ProjectIssuesService {
  private readonly logger = new Logger(ProjectIssuesService.name);

  constructor(
    private readonly projects: ProjectsService,
    private readonly issues: ProjectIssueRepository,
    private readonly tasks: ProjectTaskRepository,
    private readonly changes: ChangeRequestsService,
    private readonly people: CompanyMemberRepository,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
    // CD-223 — a resolved technical issue goes to the knowledge base
    private readonly resolved: IssueResolvedHooks,
  ) {}

  async list(projectId: string, actor: Principal, now = new Date()) {
    const { canEdit } = await this.projects.access(projectId, actor);
    const rows = (await this.issues.findMany({
      where: { projectId },
      orderBy: { seq: 'desc' },
    })) as IssueRow[];
    const [names, taskTitles, changeLabels] = await Promise.all([
      this.displayNames(
        rows.flatMap((row) => [row.ownerUserId, row.resolvedBy]),
      ),
      this.taskTitles(rows.map((row) => row.taskId)),
      this.changeLabels(projectId),
    ]);
    const today = bangkokDay(now);
    const open = rows.filter((row) => row.status === 'open');
    return {
      canEdit,
      today,
      summary: {
        open: open.length,
        overdue: open.filter((row) =>
          issueOverdue({ status: row.status, dueOn: day(row.dueOn)! }, today),
        ).length,
        scheduleDays: open.reduce(
          (sum, row) => sum + row.scheduleImpactDays,
          0,
        ),
        cost: open.reduce((sum, row) => sum + Number(row.costImpact), 0),
      },
      issues: rows.map((row) => ({
        id: row.id,
        seq: row.seq,
        label: `I-${row.seq}`,
        title: row.title,
        description: row.description,
        severity: row.severity,
        kind: row.kind,
        cause: row.cause,
        kbmsStatus: row.kbmsStatus,
        kbmsRef: row.kbmsRef,
        scheduleImpactDays: row.scheduleImpactDays,
        costImpact: Number(row.costImpact),
        ownerUserId: row.ownerUserId,
        ownerName: names.get(row.ownerUserId) ?? null,
        dueOn: day(row.dueOn),
        overdue: issueOverdue(
          { status: row.status, dueOn: day(row.dueOn)! },
          today,
        ),
        task: row.taskId
          ? { id: row.taskId, title: taskTitles.get(row.taskId) ?? '' }
          : null,
        status: row.status,
        resolution: row.resolution,
        resolvedAt: row.resolvedAt,
        resolvedByName: row.resolvedBy
          ? (names.get(row.resolvedBy) ?? null)
          : null,
        changeRequest: row.changeRequestId
          ? {
              id: row.changeRequestId,
              label: changeLabels.get(row.changeRequestId) ?? '',
            }
          : null,
        createdAt: row.createdAt,
      })),
    };
  }

  async create(projectId: string, dto: SaveIssueDto, actor: Principal) {
    const { project } = await this.editable(projectId, actor);
    const input = this.inputOf(dto, null);
    await this.checkRefs(project.companyId, projectId, input);
    const created = await this.transactions.execute(async (prisma) => {
      const last = (await this.issues.findFirst(
        {
          where: { projectId },
          orderBy: { seq: 'desc' },
          select: { seq: true },
        },
        { prisma },
      )) as { seq: number } | null;
      const row = (await this.issues.create(
        {
          data: {
            companyId: project.companyId,
            projectId,
            seq: (last?.seq ?? 0) + 1,
            ...input,
            dueOn: new Date(`${input.dueOn}T00:00:00Z`),
            createdBy: actor.userId,
          },
          select: { id: true, seq: true },
        },
        { prisma },
      )) as { id: string; seq: number };
      await this.audit.record(
        {
          eventType: 'pm.issue.created',
          companyId: project.companyId,
          ...auditActor(actor),
          resourceType: 'project_issue',
          resourceId: row.id,
          after: { projectId, title: input.title, severity: input.severity },
        },
        { prisma },
      );
      return row;
    });
    await this.tellOwner(
      project,
      created.seq,
      input.title,
      input.ownerUserId,
      actor,
    );
    return this.list(projectId, actor);
  }

  async update(
    projectId: string,
    issueId: string,
    dto: SaveIssueDto,
    actor: Principal,
  ) {
    const { project } = await this.editable(projectId, actor);
    const current = await this.requireIssue(projectId, issueId);
    if (current.status !== 'open') {
      throw new AppError('CONFLICT', 'ปัญหานี้แก้ไขเสร็จแล้ว');
    }
    const input = this.inputOf(dto, current);
    await this.checkRefs(project.companyId, projectId, input);
    await this.transactions.execute(async (prisma) => {
      await this.issues.update(
        {
          where: { id: issueId },
          data: {
            ...input,
            dueOn: new Date(`${input.dueOn}T00:00:00Z`),
            updatedBy: actor.userId,
          },
        },
        { prisma },
      );
      await this.audit.record(
        {
          eventType: 'pm.issue.updated',
          companyId: project.companyId,
          ...auditActor(actor),
          resourceType: 'project_issue',
          resourceId: issueId,
          before: {
            ownerUserId: current.ownerUserId,
            dueOn: day(current.dueOn),
            severity: current.severity,
          },
          after: { ...dto },
        },
        { prisma },
      );
    });
    if (input.ownerUserId !== current.ownerUserId) {
      await this.tellOwner(
        project,
        current.seq,
        input.title,
        input.ownerUserId,
        actor,
      );
    }
    return this.list(projectId, actor);
  }

  /** Fixed: how, by whom. The owner may close their own. */
  async resolve(
    projectId: string,
    issueId: string,
    dto: ResolveIssueDto,
    actor: Principal,
    now = new Date(),
  ) {
    const access = await this.projects.access(projectId, actor);
    const current = await this.requireIssue(projectId, issueId);
    if (!access.canEdit && current.ownerUserId !== actor.userId) {
      throw new AppError(
        'FORBIDDEN',
        'ปิดปัญหาได้เฉพาะเจ้าของปัญหา ผู้จัดการโครงการ หรือผู้มีสิทธิ์จัดการโครงการ',
      );
    }
    if (current.status !== 'open') {
      throw new AppError('CONFLICT', 'ปัญหานี้แก้ไขเสร็จแล้ว');
    }
    const cause =
      dto.cause !== undefined ? dto.cause.trim() || null : current.cause;
    const problems = resolveProblems({
      kind: current.kind,
      description: current.description,
      cause,
      resolution: dto.resolution,
    });
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'resolution', reason })),
      );
    }
    const technical = current.kind === 'technical';
    await this.transactions.execute(async (prisma) => {
      await this.issues.update(
        {
          where: { id: issueId },
          data: {
            status: 'resolved',
            resolution: dto.resolution.trim(),
            cause,
            resolvedAt: now,
            resolvedBy: actor.userId,
            // CD-223 — the knowledge base takes it from here
            ...(technical ? { kbmsStatus: 'pending' } : {}),
          },
        },
        { prisma },
      );
      await this.audit.record(
        {
          eventType: 'pm.issue.resolved',
          companyId: current.companyId,
          ...auditActor(actor),
          resourceType: 'project_issue',
          resourceId: issueId,
          after: { resolution: dto.resolution.trim(), cause },
        },
        { prisma },
      );
    });
    if (technical) await this.resolved.fire(issueId);
    return this.list(projectId, actor, now);
  }

  /** It changes what was sold: a change request draft, its days and cost carried. */
  async toChange(projectId: string, issueId: string, actor: Principal) {
    await this.editable(projectId, actor);
    const current = await this.requireIssue(projectId, issueId);
    if (current.changeRequestId) {
      throw new AppError('CONFLICT', 'ปัญหานี้แปลงเป็นคำขอเปลี่ยนแปลงแล้ว');
    }
    const created = await this.changes.create(
      projectId,
      changeFromIssue({
        seq: current.seq,
        title: current.title,
        description: current.description,
        scheduleImpactDays: current.scheduleImpactDays,
        costImpact: Number(current.costImpact),
      }),
      actor,
    );
    await this.issues.update({
      where: { id: issueId },
      data: { changeRequestId: created.changeId, updatedBy: actor.userId },
    });
    return {
      ...(await this.list(projectId, actor)),
      changeId: created.changeId,
    };
  }

  // --- helpers -------------------------------------------------------------------

  private inputOf(dto: SaveIssueDto, current: IssueRow | null) {
    const input = {
      title: (dto.title ?? current?.title ?? '').trim(),
      description:
        dto.description !== undefined
          ? dto.description.trim() || null
          : (current?.description ?? null),
      severity: dto.severity ?? current?.severity ?? 'medium',
      kind: dto.kind ?? current?.kind ?? 'general',
      cause:
        dto.cause !== undefined
          ? dto.cause.trim() || null
          : (current?.cause ?? null),
      scheduleImpactDays:
        dto.schedule_impact_days ?? current?.scheduleImpactDays ?? 0,
      costImpact: dto.cost_impact ?? Number(current?.costImpact ?? 0),
      ownerUserId: dto.owner_user_id ?? current?.ownerUserId ?? null,
      dueOn: dto.due_on?.slice(0, 10) ?? day(current?.dueOn ?? null),
      taskId:
        dto.task_id !== undefined ? dto.task_id : (current?.taskId ?? null),
    };
    const problems = issueProblems(input);
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'issue', reason })),
      );
    }
    return input as typeof input & { ownerUserId: string; dueOn: string };
  }

  private async checkRefs(
    companyId: string,
    projectId: string,
    input: { ownerUserId: string; taskId: string | null },
  ) {
    const owner = await this.people.count({
      where: { id: input.ownerUserId, companies: { some: { companyId } } },
    });
    if (!owner) {
      throw new AppError(
        'VALIDATION_FAILED',
        'เจ้าของปัญหาไม่ได้อยู่ในบริษัทนี้',
        [{ field: 'owner_user_id', reason: 'not_found' }],
      );
    }
    if (input.taskId) {
      const task = await this.tasks.count({
        where: { id: input.taskId, projectId },
      });
      if (!task) {
        throw new AppError('VALIDATION_FAILED', 'ไม่พบงานนี้ในแผนโครงการ', [
          { field: 'task_id', reason: 'not_found' },
        ]);
      }
    }
  }

  private async tellOwner(
    project: { id: string; projectNo: string; companyId: string },
    seq: number,
    title: string,
    ownerUserId: string,
    actor: Principal,
  ) {
    if (ownerUserId === actor.userId) return;
    await this.notifications
      .issueAssigned(ownerUserId, project.companyId, project, `I-${seq}`, title)
      .catch((error: Error) =>
        this.logger.warn(`issue notice not sent: ${error.message}`),
      );
  }

  private async requireIssue(projectId: string, issueId: string) {
    const row = (await this.issues.findFirst({
      where: { id: issueId, projectId },
    })) as IssueRow | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบปัญหาที่ระบุ');
    return row;
  }

  private async editable(projectId: string, actor: Principal) {
    const access = await this.projects.access(projectId, actor);
    if (!access.canEdit) {
      throw new AppError(
        'FORBIDDEN',
        'บันทึกปัญหาได้เฉพาะผู้จัดการโครงการ หรือผู้มีสิทธิ์จัดการโครงการ ขณะโครงการยังดำเนินอยู่',
      );
    }
    return access;
  }

  private async taskTitles(ids: (string | null)[]) {
    const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    if (!unique.length) return new Map<string, string>();
    const rows = (await this.tasks.findMany({
      where: { id: { in: unique } },
      select: { id: true, title: true },
    })) as { id: string; title: string }[];
    return new Map(rows.map((row) => [row.id, row.title]));
  }

  private async changeLabels(projectId: string) {
    const rows = (await this.issues.findMany({
      where: { projectId, changeRequestId: { not: null } },
      select: { changeRequestId: true },
    })) as { changeRequestId: string }[];
    if (!rows.length) return new Map<string, string>();
    return this.changes.labels(rows.map((row) => row.changeRequestId));
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
