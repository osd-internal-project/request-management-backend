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
import { ReportProgressDto } from './dto/project.dto';
import { PlanService } from './plan.service';
import {
  milestoneProgress,
  plannedProgress,
  PROGRESS_REASON_THRESHOLD,
  reportedProblems,
  workProgress,
} from './progress-rules';
import {
  ProjectMilestoneRepository,
  ProjectProgressRepository,
} from './project.repositories';
import { ProjectsService } from './projects.service';

const num = (value: Prisma.Decimal | null) =>
  value === null ? null : Number(value);

/**
 * CD-188 ติดตามความคืบหน้า — progress from what actually closed: the work
 * done (by working days, from CD-181's reports), the milestones achieved
 * (CD-182), and where the plan (CD-177) says it should be today. A figure
 * someone reports is kept beside the computed one; far from it, it must say
 * why.
 *
 * Who: whoever sees the project reads it; `pm.project.manage` or the
 * project's manager records a reported figure.
 */
@Injectable()
export class ProgressService {
  constructor(
    private readonly projects: ProjectsService,
    private readonly plan: PlanService,
    private readonly milestones: ProjectMilestoneRepository,
    private readonly reports: ProjectProgressRepository,
    private readonly people: CompanyMemberRepository,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  async view(projectId: string, actor: Principal, now = new Date()) {
    const { project, canEdit } = await this.projects.access(projectId, actor);
    const computed = await this.compute(
      projectId,
      project.companyId,
      actor,
      now,
    );
    const rows = (await this.reports.findMany({
      where: { projectId },
      orderBy: { reportedAt: 'desc' },
      take: 50,
      select: {
        id: true,
        reportedPct: true,
        computedPct: true,
        plannedPct: true,
        reason: true,
        note: true,
        reportedAt: true,
        reportedBy: true,
      },
    })) as {
      id: string;
      reportedPct: Prisma.Decimal;
      computedPct: Prisma.Decimal;
      plannedPct: Prisma.Decimal | null;
      reason: string | null;
      note: string | null;
      reportedAt: Date;
      reportedBy: string;
    }[];
    const names = await this.displayNames(rows.map((row) => row.reportedBy));
    return {
      canEdit,
      threshold: PROGRESS_REASON_THRESHOLD,
      ...computed,
      reports: rows.map((row) => ({
        ...row,
        reportedPct: Number(row.reportedPct),
        computedPct: Number(row.computedPct),
        plannedPct: num(row.plannedPct),
        reportedByName: names.get(row.reportedBy) ?? row.reportedBy,
      })),
    };
  }

  async report(
    projectId: string,
    dto: ReportProgressDto,
    actor: Principal,
    now = new Date(),
  ) {
    const { project, canEdit } = await this.projects.access(projectId, actor);
    if (!canEdit) {
      throw new AppError(
        'FORBIDDEN',
        'บันทึกความคืบหน้าได้เฉพาะผู้จัดการโครงการ หรือผู้มีสิทธิ์จัดการโครงการ',
      );
    }
    const computed = await this.compute(
      projectId,
      project.companyId,
      actor,
      now,
    );
    const reason = dto.reason?.trim() ?? '';
    const problems = reportedProblems({
      reportedPct: dto.reported_pct,
      computedPct: computed.work.pct,
      reason,
    });
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((item) => ({ field: 'reported_pct', reason: item })),
      );
    }
    await this.transactions.execute(async (prisma) => {
      const row = (await this.reports.create(
        {
          data: {
            companyId: project.companyId,
            projectId,
            reportedPct: dto.reported_pct,
            computedPct: computed.work.pct ?? 0,
            plannedPct: computed.planned.pct,
            reason: reason || null,
            note: dto.note?.trim() || null,
            reportedAt: now,
            reportedBy: actor.userId,
          },
          select: { id: true },
        },
        { prisma },
      )) as { id: string };
      await this.audit.record(
        {
          eventType: 'pm.progress.reported',
          companyId: project.companyId,
          ...auditActor(actor),
          resourceType: 'project',
          resourceId: projectId,
          after: {
            reportId: row.id,
            reportedPct: dto.reported_pct,
            computedPct: computed.work.pct,
            plannedPct: computed.planned.pct,
            reason: reason || null,
          },
        },
        { prisma },
      );
    });
    return this.view(projectId, actor, now);
  }

  private async compute(
    projectId: string,
    companyId: string,
    actor: Principal,
    now: Date,
  ) {
    const [plan, calendar, milestones] = await Promise.all([
      this.plan.view(projectId, actor),
      this.plan.workCalendar(companyId),
      this.milestones.findMany({
        where: { projectId },
        select: { status: true },
      }) as Promise<{ status: string }[]>,
    ]);
    const work = plan.tasks.filter((task) => !task.summary);
    const today = bangkokDay(now);
    const workPct = workProgress(work);
    const plannedPct = plannedProgress(work, today, calendar);
    return {
      today,
      work: {
        pct: workPct,
        done: work.filter((task) => task.status === 'done').length,
        total: work.length,
      },
      milestones: milestoneProgress(milestones),
      planned: {
        pct: plannedPct,
        // + ahead, − behind, in points
        variance:
          workPct !== null && plannedPct !== null
            ? Math.round((workPct - plannedPct) * 10) / 10
            : null,
      },
    };
  }

  private async displayNames(ids: string[]) {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map<string, string>();
    const users = (await this.people.findMany({
      where: { id: { in: unique } },
      select: { id: true, displayName: true },
    })) as { id: string; displayName: string }[];
    return new Map(users.map((user) => [user.id, user.displayName]));
  }
}
