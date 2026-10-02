import { Injectable, Logger } from '@nestjs/common';
import {
  AppError,
  AuditWriter,
  auditActor,
  Principal,
  PrismaTransactionService,
} from '@request-management/share';
import { ChangeRequestsService } from './change-requests.service';
import {
  evidenceMove,
  evidenceNote,
  type TaskEvidence,
} from './evidence-rules';
import { wbsCodes } from './plan-rules';
import {
  ProjectInstallationRepository,
  ProjectTaskRepository,
  ProjectTestItemRepository,
} from './project.repositories';
import { statusStamps } from './task-rules';
import { testState } from './test-rules';

interface TaskRow {
  id: string;
  companyId: string;
  projectId: string;
  parentId: string | null;
  seq: number;
  title: string;
  status: string;
  durationDays: number;
  startedAt: Date | null;
  doneAt: Date | null;
  changeRequestId: string | null;
}

/**
 * CD-218 นำไปใช้งาน — the plan's tasks closed by their evidence: an
 * installation point (CD-216) or a test item (CD-221) may be linked to a
 * leaf task; once all of a task's evidence holds, the task is done — its
 * history says so — and the project's progress (CD-188) follows, with
 * nobody closing it by hand. Work a change request added still waits for
 * the change's approval (CD-185).
 */
@Injectable()
export class TaskEvidenceService {
  private readonly logger = new Logger(TaskEvidenceService.name);

  constructor(
    private readonly tasks: ProjectTaskRepository,
    private readonly installs: ProjectInstallationRepository,
    private readonly testItems: ProjectTestItemRepository,
    private readonly changes: ChangeRequestsService,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  /** The leaf tasks evidence may be linked to, labelled with their WBS code. */
  async options(projectId: string) {
    const rows = await this.rows(projectId);
    const codes = wbsCodes(rows);
    const parents = new Set(rows.map((row) => row.parentId));
    return rows
      .filter((row) => !parents.has(row.id) && row.status !== 'cancelled')
      .map((row) => ({
        id: row.id,
        label: `${codes.get(row.id) ?? ''} ${row.title}`.trim(),
      }));
  }

  /** A task evidence may be linked to: a leaf of this project, not cancelled. */
  async assertTask(projectId: string, taskId: string | null) {
    if (!taskId) return;
    const task = (await this.tasks.findFirst({
      where: { id: taskId, projectId },
      select: { status: true, _count: { select: { children: true } } },
    })) as { status: string; _count: { children: number } } | null;
    if (!task || task.status === 'cancelled' || task._count.children > 0) {
      throw new AppError(
        'VALIDATION_FAILED',
        'ผูกได้เฉพาะงานย่อยในแผนของโครงการนี้ที่ยังไม่ยกเลิก',
        [{ field: 'task_id', reason: 'not_a_leaf' }],
      );
    }
  }

  /** Each task's status brought in line with its evidence. */
  async sync(
    projectId: string,
    taskIds: readonly (string | null | undefined)[],
    actor: Principal,
    now = new Date(),
  ) {
    for (const taskId of new Set(taskIds.filter(Boolean) as string[])) {
      try {
        await this.syncOne(projectId, taskId, actor, now);
      } catch (error) {
        this.logger.warn(
          `task ${taskId} not synced to its evidence: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  private async syncOne(
    projectId: string,
    taskId: string,
    actor: Principal,
    now: Date,
  ) {
    const task = (await this.tasks.findFirst({
      where: { id: taskId, projectId },
    })) as TaskRow | null;
    if (!task) return;
    const evidence = await this.evidence(projectId, taskId);
    const to = evidenceMove(task.status, evidence);
    if (!to) return;
    if (to === 'done' && task.status === 'open') {
      // work a change request added waits for the change
      const blocked = await this.changes.workMayStart(task.changeRequestId);
      if (blocked) return;
    }
    const stamps = statusStamps(task, to, now, actor.userId);
    if (!stamps) return;
    const note = evidenceNote(to, evidence);
    await this.transactions.execute(async (prisma) => {
      await prisma.projectTask.update({
        where: { id: taskId },
        data: { ...stamps, updatedBy: actor.userId },
      });
      await prisma.projectTaskUpdate.create({
        data: {
          companyId: task.companyId,
          taskId,
          authorId: actor.userId,
          note,
          statusFrom: task.status,
          statusTo: stamps.status,
          createdAt: now,
        },
      });
      await this.audit.record(
        {
          eventType: 'pm.task.evidence_status',
          companyId: task.companyId,
          ...auditActor(actor),
          resourceType: 'project_task',
          resourceId: taskId,
          before: { status: task.status },
          after: { status: stamps.status, note },
        },
        { prisma },
      );
    });
  }

  private async evidence(
    projectId: string,
    taskId: string,
  ): Promise<TaskEvidence> {
    const [installs, tests] = await Promise.all([
      this.installs.findMany({
        where: { projectId, taskId, deletedAt: null },
        select: { installedOn: true },
      }) as Promise<{ installedOn: Date | null }[]>,
      this.testItems.findMany({
        where: { projectId, taskId, deletedAt: null },
        select: {
          waivedAt: true,
          runs: {
            orderBy: { testedAt: 'desc' },
            take: 1,
            select: { result: true },
          },
        },
      }) as unknown as Promise<
        { waivedAt: Date | null; runs: { result: string }[] }[]
      >,
    ]);
    return {
      installs: installs.map((row) => ({
        installed: Boolean(row.installedOn),
      })),
      tests: tests.map((row) => ({ state: testState(row) })),
    };
  }

  private async rows(projectId: string) {
    return (await this.tasks.findMany({
      where: { projectId },
      orderBy: [{ parentId: 'asc' }, { seq: 'asc' }],
      select: {
        id: true,
        parentId: true,
        seq: true,
        title: true,
        status: true,
        durationDays: true,
      },
    })) as TaskRow[];
  }
}
