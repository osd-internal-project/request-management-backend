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
import { readBoq } from '../presales/solution-rules';
import { SaveTechPlanDto } from './dto/project.dto';
import { wbsCodes } from './plan-rules';
import { PlanService } from './plan.service';
import {
  ProjectRepository,
  ProjectTaskEquipmentRepository,
  ProjectTaskRepository,
} from './project.repositories';
import { ProjectsService } from './projects.service';
import {
  cleanEquipment,
  handoffBlockers,
  weeklyEquipment,
} from './tech-plan-rules';

interface TaskRow {
  id: string;
  parentId: string | null;
  seq: number;
  title: string;
  status: string;
  ownerUserId: string | null;
  crewUserIds: string[];
  needsEquipment: boolean;
  durationDays: number;
}

interface EquipmentRow {
  id: string;
  taskId: string;
  boqIndex: number | null;
  name: string;
  quantity: Prisma.Decimal;
  unit: string | null;
  note: string | null;
}

/**
 * CD-209 วางแผนงานเทคนิค — the technical side of the project plan: for
 * each piece of work, who works it beside its owner and the equipment and
 * tools it needs (BOQ lines or anything else), with the equipment summed
 * week by week from the plan's dates (CD-178). Handoff 7 (PM → Engineer)
 * holds until every task has an owner and every task that needs equipment
 * lists it: until then no task may start (CD-181) or be closed by its
 * evidence (CD-218). Allocating people properly waits for HR (CD-17).
 *
 * Who: whoever sees the project reads it; `pm.project.manage` or the
 * project's manager plans it.
 */
@Injectable()
export class TechPlanService {
  constructor(
    private readonly projects: ProjectsService,
    private readonly plan: PlanService,
    private readonly projectRows: ProjectRepository,
    private readonly tasks: ProjectTaskRepository,
    private readonly equipment: ProjectTaskEquipmentRepository,
    private readonly people: CompanyMemberRepository,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  async view(projectId: string, actor: Principal) {
    const access = await this.projects.access(projectId, actor);
    const [planned, rows, lines, boq] = await Promise.all([
      this.plan.view(projectId, actor),
      this.rows(projectId),
      this.lines(projectId),
      this.boq(projectId),
    ]);
    const leaves = planned.tasks.filter((task) => !task.summary);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const names = await this.displayNames(
      rows.flatMap((row) => [row.ownerUserId, ...row.crewUserIds]),
    );
    const tasks = leaves.map((task) => {
      const row = byId.get(task.id);
      const equipment = lines
        .filter((line) => line.taskId === task.id)
        .map((line) => ({
          id: line.id,
          boqIndex: line.boqIndex,
          name: line.name,
          quantity: Number(line.quantity),
          unit: line.unit,
          note: line.note,
        }));
      return {
        id: task.id,
        label: `${task.wbs} ${task.title}`.trim(),
        status: task.status,
        start: task.start,
        finish: task.finish,
        ownerUserId: task.ownerUserId,
        ownerName: task.ownerName,
        crew: (row?.crewUserIds ?? []).map((id) => ({
          id,
          name: names.get(id) ?? id,
        })),
        needsEquipment: row?.needsEquipment ?? false,
        equipment,
      };
    });
    const blockers = handoffBlockers(
      tasks.map((task) => ({
        label: task.label,
        ownerUserId: task.ownerUserId,
        needsEquipment: task.needsEquipment,
        equipment: task.equipment.length,
        status: task.status,
      })),
    );
    return {
      canEdit: access.canEdit,
      handoff: { ready: blockers.length === 0, blockers },
      boq: boq.map((line, index) => ({
        index,
        label: `BOQ ${index + 1}: ${line.name} × ${line.quantity}${line.unit ? ` ${line.unit}` : ''}`,
      })),
      tasks,
      weekly: weeklyEquipment(tasks),
    };
  }

  /**
   * Handoff 7, for the task services: what still keeps technical work from
   * starting (empty = it may start).
   */
  async handoffBlockers(projectId: string) {
    const [rows, lines] = await Promise.all([
      this.rows(projectId),
      this.lines(projectId),
    ]);
    const codes = wbsCodes(rows);
    const parents = new Set(rows.map((row) => row.parentId));
    return handoffBlockers(
      rows
        .filter((row) => !parents.has(row.id))
        .map((row) => ({
          label: `${codes.get(row.id) ?? ''} ${row.title}`.trim(),
          ownerUserId: row.ownerUserId,
          needsEquipment: row.needsEquipment,
          equipment: lines.filter((line) => line.taskId === row.id).length,
          status: row.status,
        })),
    );
  }

  /** A task's crew and equipment, set whole. */
  async saveTask(
    projectId: string,
    taskId: string,
    dto: SaveTechPlanDto,
    actor: Principal,
  ) {
    const access = await this.projects.access(projectId, actor);
    if (!access.canEdit) {
      throw new AppError(
        'FORBIDDEN',
        'วางแผนงานเทคนิคได้เฉพาะผู้จัดการโครงการ หรือผู้มีสิทธิ์จัดการโครงการ',
      );
    }
    const task = (await this.tasks.findFirst({
      where: { id: taskId, projectId },
      select: {
        id: true,
        title: true,
        crewUserIds: true,
        needsEquipment: true,
        _count: { select: { children: true } },
      },
    })) as {
      id: string;
      title: string;
      crewUserIds: string[];
      needsEquipment: boolean;
      _count: { children: number };
    } | null;
    if (!task) throw new AppError('NOT_FOUND', 'ไม่พบงานในแผน');
    if (task._count.children > 0) {
      throw new AppError(
        'VALIDATION_FAILED',
        'วางแผนเทคนิคได้เฉพาะงานย่อย — งานกลุ่มรวมจากงานย่อย',
      );
    }
    const crew =
      dto.crew_user_ids === undefined
        ? undefined
        : [...new Set(dto.crew_user_ids.filter(Boolean))];
    if (crew?.length) {
      const found = await this.people.count({
        where: {
          id: { in: crew },
          companies: { some: { companyId: access.project.companyId } },
        },
      });
      if (found !== crew.length) {
        throw new AppError(
          'VALIDATION_FAILED',
          'มีทีมงานที่ไม่ได้อยู่ในบริษัทนี้',
        );
      }
    }
    const cleaned =
      dto.equipment === undefined
        ? null
        : cleanEquipment(dto.equipment, await this.boq(projectId));
    if (cleaned?.problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        cleaned.problems[0],
        cleaned.problems.map((reason) => ({ field: 'equipment', reason })),
      );
    }
    await this.transactions.execute(async (prisma) => {
      await prisma.projectTask.update({
        where: { id: taskId },
        data: {
          crewUserIds: crew,
          needsEquipment: dto.needs_equipment,
          updatedBy: actor.userId,
        },
      });
      if (cleaned) {
        await prisma.projectTaskEquipment.deleteMany({ where: { taskId } });
        if (cleaned.lines.length) {
          await prisma.projectTaskEquipment.createMany({
            data: cleaned.lines.map((line) => ({
              companyId: access.project.companyId,
              projectId,
              taskId,
              ...line,
              createdBy: actor.userId,
            })),
          });
        }
      }
      await this.audit.record(
        {
          eventType: 'pm.tech_plan.saved',
          companyId: access.project.companyId,
          ...auditActor(actor),
          resourceType: 'project_task',
          resourceId: taskId,
          before: {
            crewUserIds: task.crewUserIds,
            needsEquipment: task.needsEquipment,
          },
          after: {
            crewUserIds: crew,
            needsEquipment: dto.needs_equipment,
            equipment: cleaned?.lines.length,
          },
        },
        { prisma },
      );
    });
    return this.view(projectId, actor);
  }

  // --- helpers -----------------------------------------------------------------------

  private async boq(projectId: string) {
    const row = (await this.projectRows.findFirst({
      where: { id: projectId },
      select: { baseline: true },
    })) as { baseline: unknown } | null;
    return readBoq((row?.baseline as { boq?: unknown } | null)?.boq).map(
      (line) => ({
        name: line.name || line.productCode,
        unit: line.unit,
        quantity: line.quantity,
      }),
    );
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
        ownerUserId: true,
        crewUserIds: true,
        needsEquipment: true,
        durationDays: true,
      },
    })) as TaskRow[];
  }

  private async lines(projectId: string) {
    return (await this.equipment.findMany({
      where: { projectId },
      orderBy: { createdAt: 'asc' },
    })) as EquipmentRow[];
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
