import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AppError,
  AuditWriter,
  auditActor,
  hasPermission,
  OBJECT_STORAGE,
  Principal,
  PrismaTransactionService,
} from '@request-management/share';
import type { ObjectStorage } from '@request-management/share';
import { CompanyMemberRepository } from '../access/company-member.repository';
import { NotificationsService } from '../notifications/notifications.service';
import { safeFileName } from '../requests/attachments.service';
import { PlanService } from './plan.service';
import {
  ProjectTaskFileRepository,
  ProjectTaskRepository,
  ProjectTaskUpdateRepository,
} from './project.repositories';
import { ProjectsService } from './projects.service';
import {
  reportProblems,
  statusStamps,
  WORK_STATUSES,
  type WorkStatus,
} from './task-rules';

export const MAX_TASK_FILE_BYTES = 25 * 1024 * 1024;
export const TASK_FILE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/webp',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
] as const;

interface UploadedTaskFile {
  readonly originalname: string;
  readonly mimetype: string;
  readonly size: number;
  readonly buffer: Buffer;
}

interface TaskRow {
  id: string;
  companyId: string;
  projectId: string;
  title: string;
  ownerUserId: string | null;
  status: string;
  startedAt: Date | null;
  doneAt: Date | null;
  _count: { children: number };
}

/**
 * CD-181 งานย่อย — the work itself: whoever a task is handed to sees it
 * among "งานของฉัน" with its due day (the plan's finish), reports on it —
 * a note, photos or files, a status move — often from a phone on site, and
 * the project's manager hears when it is done.
 *
 * Who reports: the task's owner, the project's manager, `pm.project.manage`.
 * Who reads: whoever sees the project (an owner does, CD-181).
 */
@Injectable()
export class TaskWorkService {
  private readonly logger = new Logger(TaskWorkService.name);

  constructor(
    private readonly projects: ProjectsService,
    private readonly plan: PlanService,
    private readonly tasks: ProjectTaskRepository,
    private readonly updates: ProjectTaskUpdateRepository,
    private readonly files: ProjectTaskFileRepository,
    private readonly people: CompanyMemberRepository,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  /** The tasks handed to me that are still to do, soonest due first. */
  async mine(actor: Principal) {
    const rows = (await this.tasks.findMany({
      where: {
        companyId: actor.activeCompanyId,
        ownerUserId: actor.userId,
        status: { in: ['open', 'in_progress'] },
        project: { status: { in: ['active', 'on_hold'] } },
      },
      select: {
        id: true,
        projectId: true,
        project: {
          select: { id: true, projectNo: true, name: true, status: true },
        },
      },
      take: 500,
    })) as unknown as {
      id: string;
      projectId: string;
      project: { id: string; projectNo: string; name: string; status: string };
    }[];
    const out: {
      id: string;
      wbs: string;
      title: string;
      status: string;
      start: string | null;
      finish: string | null;
      critical: boolean;
      summary: boolean;
      milestone: { id: string; title: string; status: string } | null;
      project: (typeof rows)[number]['project'];
    }[] = [];
    for (const projectId of [...new Set(rows.map((row) => row.projectId))]) {
      const view = await this.plan.view(projectId, actor);
      const project = rows.find((row) => row.projectId === projectId)!.project;
      for (const task of view.tasks) {
        if (!rows.some((row) => row.id === task.id)) continue;
        out.push({
          id: task.id,
          wbs: task.wbs,
          title: task.title,
          status: task.status,
          start: task.start,
          finish: task.finish,
          critical: task.critical,
          summary: task.summary,
          milestone: task.milestone,
          project,
        });
      }
    }
    return out.sort((a, b) =>
      (a.finish ?? '9999').localeCompare(b.finish ?? '9999'),
    );
  }

  async detail(projectId: string, taskId: string, actor: Principal) {
    const access = await this.projects.access(projectId, actor);
    const task = await this.requireTask(projectId, taskId);
    const view = await this.plan.view(projectId, actor);
    const planned = view.tasks.find((row) => row.id === taskId) ?? null;
    const [updates, files] = await Promise.all([
      this.updates.findMany({
        where: { taskId },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          authorId: true,
          note: true,
          statusFrom: true,
          statusTo: true,
          createdAt: true,
        },
      }) as Promise<
        {
          id: string;
          authorId: string;
          note: string;
          statusFrom: string | null;
          statusTo: string | null;
          createdAt: Date;
        }[]
      >,
      this.files.findMany({
        where: { taskId, deletedAt: null },
        orderBy: { uploadedAt: 'desc' },
        select: {
          id: true,
          updateId: true,
          fileName: true,
          mimeType: true,
          sizeBytes: true,
          uploadedBy: true,
          uploadedAt: true,
        },
      }) as Promise<
        {
          id: string;
          updateId: string | null;
          fileName: string;
          mimeType: string;
          sizeBytes: number;
          uploadedBy: string;
          uploadedAt: Date;
        }[]
      >,
    ]);
    const names = await this.displayNames([
      task.ownerUserId,
      ...updates.map((row) => row.authorId),
      ...files.map((row) => row.uploadedBy),
    ]);
    return {
      task: {
        id: task.id,
        title: task.title,
        status: task.status,
        ownerUserId: task.ownerUserId,
        ownerName: task.ownerUserId
          ? (names.get(task.ownerUserId) ?? null)
          : null,
        startedAt: task.startedAt,
        doneAt: task.doneAt,
        wbs: planned?.wbs ?? '',
        start: planned?.start ?? null,
        finish: planned?.finish ?? null,
        critical: planned?.critical ?? false,
        summary: task._count.children > 0,
        description: planned?.description ?? null,
        milestone: planned?.milestone ?? null,
      },
      project: {
        id: access.project.id,
        projectNo: access.project.projectNo,
        name: access.project.name,
      },
      canReport: this.mayReport(task, access.project.managerUserId, actor),
      updates: updates.map((row) => ({
        ...row,
        authorName: names.get(row.authorId) ?? row.authorId,
        files: files
          .filter((file) => file.updateId === row.id)
          .map((file) => file.id),
      })),
      files: files.map((row) => ({
        ...row,
        uploadedByName: names.get(row.uploadedBy) ?? row.uploadedBy,
      })),
    };
  }

  /** A report from the work: a note, files, a status move — any of them. */
  async report(
    projectId: string,
    taskId: string,
    body: { note?: string; status?: string },
    uploads: readonly UploadedTaskFile[],
    actor: Principal,
    now = new Date(),
  ) {
    const access = await this.projects.access(projectId, actor);
    const task = await this.requireTask(projectId, taskId);
    if (!this.mayReport(task, access.project.managerUserId, actor)) {
      throw new AppError(
        'FORBIDDEN',
        'รายงานได้เฉพาะผู้รับผิดชอบงาน ผู้จัดการโครงการ หรือผู้มีสิทธิ์จัดการโครงการ',
      );
    }
    if (
      access.project.status !== 'active' &&
      access.project.status !== 'on_hold'
    ) {
      throw new AppError('CONFLICT', 'โครงการปิดหรือยกเลิกแล้ว');
    }
    const note = (body.note ?? '').trim();
    const to = body.status?.trim() ? body.status.trim() : null;
    const problems = reportProblems({
      summary: task._count.children > 0,
      status: task.status,
      note,
      to,
      files: uploads.length,
    });
    for (const file of uploads) {
      if (!(TASK_FILE_TYPES as readonly string[]).includes(file.mimetype)) {
        problems.push(
          `${file.originalname}: แนบได้เฉพาะรูป PDF Word หรือ Excel`,
        );
      }
      if (file.size > MAX_TASK_FILE_BYTES) {
        problems.push(`${file.originalname}: ไฟล์ใหญ่เกิน 25 MB`);
      }
    }
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'report', reason })),
      );
    }
    const stamps =
      to && (WORK_STATUSES as readonly string[]).includes(to)
        ? statusStamps(task, to as WorkStatus, now, actor.userId)
        : null;

    // bytes first, rows second — like request attachments
    const stored: {
      id: string;
      key: string;
      file: UploadedTaskFile;
      name: string;
    }[] = [];
    for (const file of uploads) {
      const id = randomUUID();
      const name = safeFileName(file.originalname);
      const key = `projects/${projectId}/tasks/${taskId}/${id}/${name}`;
      await this.storage.put(key, file.buffer, {
        contentType: file.mimetype,
        size: file.size,
      });
      stored.push({ id, key, file, name });
    }
    const updateId = randomUUID();
    try {
      await this.transactions.execute(async (prisma) => {
        await this.updates.create(
          {
            data: {
              id: updateId,
              companyId: task.companyId,
              taskId,
              authorId: actor.userId,
              note,
              statusFrom: stamps ? task.status : null,
              statusTo: stamps ? stamps.status : null,
              createdAt: now,
            },
          },
          { prisma },
        );
        for (const item of stored) {
          await this.files.create(
            {
              data: {
                id: item.id,
                companyId: task.companyId,
                taskId,
                updateId,
                fileName: item.name,
                mimeType: item.file.mimetype,
                sizeBytes: item.file.size,
                storageKey: item.key,
                uploadedBy: actor.userId,
                uploadedAt: now,
              },
            },
            { prisma },
          );
        }
        if (stamps) {
          await this.tasks.update(
            {
              where: { id: taskId },
              data: { ...stamps, updatedBy: actor.userId },
            },
            { prisma },
          );
        }
        await this.audit.record(
          {
            eventType: 'pm.task.reported',
            companyId: task.companyId,
            ...auditActor(actor),
            resourceType: 'project_task',
            resourceId: taskId,
            after: {
              note,
              statusFrom: stamps ? task.status : null,
              statusTo: stamps?.status ?? null,
              files: stored.map((item) => item.name),
            },
          },
          { prisma },
        );
      });
    } catch (error) {
      for (const item of stored) {
        await this.storage.remove(item.key).catch(() => undefined);
      }
      throw error;
    }

    if (
      stamps?.status === 'done' &&
      access.project.managerUserId !== actor.userId
    ) {
      await this.notifications
        .taskDone(
          access.project.managerUserId,
          task.companyId,
          access.project,
          task.title,
          actor.displayName ?? actor.userId,
        )
        .catch((error: Error) =>
          this.logger.warn(`task done notice not sent: ${error.message}`),
        );
    }
    return this.detail(projectId, taskId, actor);
  }

  async download(
    projectId: string,
    taskId: string,
    fileId: string,
    actor: Principal,
  ): Promise<{ stream: Readable; fileName: string; mimeType: string }> {
    await this.projects.access(projectId, actor);
    const row = (await this.files.findFirst({
      where: { id: fileId, taskId, deletedAt: null, task: { projectId } },
      select: { storageKey: true, fileName: true, mimeType: true },
    })) as { storageKey: string; fileName: string; mimeType: string } | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบไฟล์');
    return {
      stream: await this.storage.get(row.storageKey),
      fileName: row.fileName,
      mimeType: row.mimeType,
    };
  }

  // --- helpers -------------------------------------------------------------------

  private mayReport(
    task: Pick<TaskRow, 'ownerUserId'>,
    managerUserId: string,
    actor: Principal,
  ) {
    return (
      task.ownerUserId === actor.userId ||
      managerUserId === actor.userId ||
      hasPermission(actor, 'pm.project.manage')
    );
  }

  private async requireTask(projectId: string, taskId: string) {
    const row = (await this.tasks.findFirst({
      where: { id: taskId, projectId },
      select: {
        id: true,
        companyId: true,
        projectId: true,
        title: true,
        ownerUserId: true,
        status: true,
        startedAt: true,
        doneAt: true,
        _count: {
          select: { children: { where: { status: { not: 'cancelled' } } } },
        },
      },
    })) as unknown as TaskRow | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบงานที่ระบุ');
    return row;
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
