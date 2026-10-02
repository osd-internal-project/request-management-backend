import { Injectable } from '@nestjs/common';
import { AppError, Principal } from '@request-management/share';
import { AddDevItemsDto, SaveTaskDto } from './dto/project.dto';
import { addProblems, coverage, devSources, itemTitle } from './dev-plan-rules';
import { PlanService } from './plan.service';
import {
  ProjectChangeRequestRepository,
  ProjectRepository,
  ProjectTaskRepository,
} from './project.repositories';
import { ProjectsService } from './projects.service';

interface DevRow {
  id: string;
  parentId: string | null;
  devKind: string | null;
  sowRef: string | null;
  status: string;
}

/**
 * CD-212 แผนงานพัฒนาซอฟต์แวร์ — software work broken from the SOW into
 * rounds of development, inside the project's own plan (CD-177): a round is
 * a summary task, each SOW line under it a task with its owner and days.
 * So dates, hand-offs (CD-209) and closing on evidence (CD-218) work for it
 * as for any other work. The SOW is the baseline's scope lines and
 * deliverables plus what approved change requests added.
 *
 * Who: whoever sees the project reads it; `pm.project.manage` or the
 * project's manager plans it.
 */
@Injectable()
export class DevPlanService {
  constructor(
    private readonly projects: ProjectsService,
    private readonly projectRows: ProjectRepository,
    private readonly tasks: ProjectTaskRepository,
    private readonly changes: ProjectChangeRequestRepository,
    private readonly plan: PlanService,
  ) {}

  async view(projectId: string, actor: Principal) {
    const [plan, rows, sources] = await Promise.all([
      this.plan.view(projectId, actor),
      this.devRows(projectId),
      this.sources(projectId),
    ]);
    const byId = new Map(plan.tasks.map((task) => [task.id, task]));
    const items = rows.filter((row) => row.devKind === 'item');
    const label = new Map(sources.map((row) => [row.ref, row.text]));
    const cover = coverage(sources, items);
    const iterations = rows
      .filter((row) => row.devKind === 'iteration' && byId.has(row.id))
      .map((row) => {
        const task = byId.get(row.id)!;
        const children = items
          .filter((item) => item.parentId === row.id && byId.has(item.id))
          .map((item) => {
            const child = byId.get(item.id)!;
            return {
              id: item.id,
              wbs: child.wbs,
              title: child.title,
              sowRef: item.sowRef,
              sowText: item.sowRef ? (label.get(item.sowRef) ?? null) : null,
              ownerName: child.ownerName,
              durationDays: child.durationDays,
              status: child.status,
              start: child.start,
              finish: child.finish,
            };
          })
          .sort((a, b) => a.wbs.localeCompare(b.wbs, 'en', { numeric: true }));
        return {
          id: row.id,
          wbs: task.wbs,
          title: task.title,
          ownerName: task.ownerName,
          start: task.start,
          finish: task.finish,
          milestone: task.milestone,
          done: children.filter((child) => child.status === 'done').length,
          items: children,
        };
      })
      .sort((a, b) => a.wbs.localeCompare(b.wbs, 'en', { numeric: true }));
    return {
      canEdit: plan.canEdit,
      total: cover.total,
      planned: cover.planned,
      done: cover.done,
      unplanned: cover.unplanned,
      iterations,
    };
  }

  /** A new round of development: a summary task in the plan. */
  async addIteration(projectId: string, dto: SaveTaskDto, actor: Principal) {
    const created = await this.plan.create(
      projectId,
      { ...dto, duration_days: dto.duration_days ?? 0 },
      actor,
    );
    await this.tasks.update({
      where: { id: created.taskId },
      data: { devKind: 'iteration', updatedBy: actor.userId },
    });
    return this.view(projectId, actor);
  }

  /** SOW lines into a round, each a task with its owner and days. */
  async addItems(
    projectId: string,
    iterationId: string,
    dto: AddDevItemsDto,
    actor: Principal,
  ) {
    const access = await this.projects.access(projectId, actor);
    if (!access.canEdit) {
      throw new AppError(
        'FORBIDDEN',
        'วางแผนงานพัฒนาได้เฉพาะผู้จัดการโครงการ หรือผู้มีสิทธิ์จัดการโครงการ',
      );
    }
    const [rows, sources] = await Promise.all([
      this.devRows(projectId),
      this.sources(projectId),
    ]);
    const iteration = rows.find(
      (row) =>
        row.id === iterationId &&
        row.devKind === 'iteration' &&
        row.status !== 'cancelled',
    );
    if (!iteration) throw new AppError('NOT_FOUND', 'ไม่พบรอบงานพัฒนา');
    const planned = new Set(
      rows
        .filter((row) => row.devKind === 'item' && row.status !== 'cancelled')
        .map((row) => row.sowRef)
        .filter((ref): ref is string => Boolean(ref)),
    );
    const problems = addProblems({ refs: dto.refs, sources, planned });
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'refs', reason })),
      );
    }
    for (const ref of dto.refs) {
      const source = sources.find((row) => row.ref === ref)!;
      const created = await this.plan.create(
        projectId,
        {
          title: itemTitle(source.text),
          description: `ข้อ SOW ${ref}`,
          parent_id: iterationId,
          owner_user_id: dto.owner_user_id ?? null,
          duration_days: dto.duration_days ?? 5,
          // work a change added waits for it, as any change work (CD-185)
          change_request_id: ref.startsWith('change:') ? ref.slice(7) : null,
        },
        actor,
      );
      await this.tasks.update({
        where: { id: created.taskId },
        data: { devKind: 'item', sowRef: ref, updatedBy: actor.userId },
      });
    }
    return this.view(projectId, actor);
  }

  // --- helpers -----------------------------------------------------------------------

  private async devRows(projectId: string) {
    return (await this.tasks.findMany({
      where: { projectId, devKind: { not: null } },
      select: {
        id: true,
        parentId: true,
        devKind: true,
        sowRef: true,
        status: true,
      },
    })) as DevRow[];
  }

  private async sources(projectId: string) {
    const [project, approved] = await Promise.all([
      this.projectRows.findFirst({
        where: { id: projectId },
        select: { baseline: true },
      }) as Promise<{ baseline: unknown } | null>,
      this.changes.findMany({
        where: { projectId, status: 'approved' },
        orderBy: { seq: 'asc' },
        select: { id: true, seq: true, scopeAdded: true },
      }) as Promise<{ id: string; seq: number; scopeAdded: string | null }[]>,
    ]);
    return devSources(project?.baseline ?? null, approved);
  }
}
