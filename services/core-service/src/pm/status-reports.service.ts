import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import {
  AppError,
  AuditWriter,
  auditActor,
  Principal,
  PrismaTransactionService,
} from '@request-management/share';
import { CompanyMemberRepository } from '../access/company-member.repository';
import { backgroundTick } from '../common/background-tick';
import { bangkokDay } from '../crm/kyc-rules';
import { CrmConfigRepository } from '../crm/segment.repositories';
import { NotificationsService } from '../notifications/notifications.service';
import { SaveStatusReportDto } from './dto/project.dto';
import {
  byRisk,
  healthThresholds,
  projectHealth,
  weekStart,
  type Health,
} from './health-rules';
import { issueOverdue } from './issue-rules';
import { PaymentsService } from './payments.service';
import { PlanService } from './plan.service';
import { ProgressService } from './progress.service';
import { levelOf } from './project-risk-rules';
import {
  ProjectBudgetRepository,
  ProjectIssueRepository,
  ProjectRiskRepository,
  ProjectStatusReportRepository,
} from './project.repositories';
import { ProjectsService } from './projects.service';

/** What a report freezes: the health and the figures behind it. */
export interface StatusSnapshot {
  today: string;
  health: Health;
  progress: {
    workPct: number | null;
    plannedPct: number | null;
    variance: number | null;
  };
  milestones: {
    achieved: number;
    total: number;
    late: { title: string; dueOn: string | null; forecast: string | null }[];
  };
  risks: { open: number; high: number; critical: number };
  issues: { open: number; overdue: number };
  budget: {
    versionNo: number;
    total: number;
    firstTotal: number;
    growthPct: number | null;
  } | null;
  payments: {
    scheduled: number;
    received: number;
    outstanding: number;
    overdue: number;
    overdueCount: number;
  };
}

interface ReportRow {
  id: string;
  companyId: string;
  projectId: string;
  weekStart: Date;
  status: string;
  healthLevel: string;
  healthScore: number;
  snapshot: unknown;
  snapshotAt: Date;
  accomplished: string | null;
  nextSteps: string | null;
  helpNeeded: string | null;
  submittedAt: Date | null;
  submittedBy: string | null;
}

type Access = Awaited<ReturnType<ProjectsService['access']>>;

const day = (value: Date) => value.toISOString().slice(0, 10);
const asDate = (value: string) => new Date(`${value}T00:00:00Z`);
const round1 = (value: number) => Math.round(value * 10) / 10;
/** How many projects' health are worked out at once on the portfolio. */
const PORTFOLIO_BATCH = 4;

/**
 * CD-192 รายงานโครงการ — a project's health (health-rules), the weekly
 * status report the manager completes and submits, and the portfolio that
 * puts the projects most at risk first. Each Monday the system drafts the
 * week's report for every running project from its own figures and tells
 * the manager; a draft's figures are refreshed daily until it is submitted,
 * which freezes them. The Data Mart (CD-91) reads the reports for the
 * executive dashboard in Metabase.
 *
 * Who: whoever sees a project reads its reports; `pm.project.manage` or
 * its manager writes and submits them; the portfolio lists the projects the
 * caller may see (`pm.project.read`: all).
 */
@Injectable()
export class StatusReportsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StatusReportsService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly projects: ProjectsService,
    private readonly plan: PlanService,
    private readonly progress: ProgressService,
    private readonly payments: PaymentsService,
    private readonly reports: ProjectStatusReportRepository,
    private readonly risks: ProjectRiskRepository,
    private readonly issues: ProjectIssueRepository,
    private readonly budgets: ProjectBudgetRepository,
    private readonly configs: CrmConfigRepository,
    private readonly people: CompanyMemberRepository,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  onModuleInit(): void {
    const interval =
      this.config.get<number>('pm.statusReportIntervalMs') ?? 3600000;
    if (interval <= 0) return;
    this.timer = setInterval(
      backgroundTick(this.logger, 'CD-192 status reports', () => this.sweep()),
      interval,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // --- health -----------------------------------------------------------------------

  /** The project's health and the figures behind it, as of now. */
  async snapshot(
    access: Access,
    actor: Principal,
    now = new Date(),
  ): Promise<StatusSnapshot> {
    const projectId = access.project.id;
    const today = bangkokDay(now);
    const [progress, planned, risks, issues, budgets, payments, thresholds] =
      await Promise.all([
        this.progress.view(projectId, actor, now),
        this.plan.view(projectId, actor),
        this.risks.findMany({
          where: { projectId, status: 'open' },
          select: { likelihood: true, impact: true },
        }) as Promise<{ likelihood: number; impact: number }[]>,
        this.issues.findMany({
          where: { projectId, status: 'open' },
          select: { status: true, dueOn: true },
        }) as Promise<{ status: string; dueOn: Date }[]>,
        this.budgets.findMany({
          where: { projectId, status: { in: ['locked', 'superseded'] } },
          orderBy: { versionNo: 'asc' },
          select: { versionNo: true, status: true, total: true },
        }) as Promise<
          { versionNo: number; status: string; total: Prisma.Decimal }[]
        >,
        this.payments.view(projectId, actor, now),
        this.thresholds(access.project.companyId),
      ]);
    const late = planned.milestones.filter(
      (row) =>
        row.status === 'planned' &&
        (row.late || (row.dueOn !== null && row.dueOn < today)),
    );
    const levels = risks.map((row) => levelOf(row.likelihood, row.impact));
    const first = budgets[0];
    const current = budgets.find((row) => row.status === 'locked');
    const firstTotal = first ? Number(first.total) : 0;
    const growthPct =
      current && firstTotal > 0
        ? round1(((Number(current.total) - firstTotal) / firstTotal) * 100)
        : null;
    const overdueRows = payments.installments.filter((row) => row.overdue);
    const facts = {
      variance: progress.planned.variance,
      milestonesLate: late.length,
      risksHigh: levels.filter((level) => level === 'high').length,
      risksCritical: levels.filter((level) => level === 'critical').length,
      issuesOverdue: issues.filter((row) =>
        issueOverdue({ status: row.status, dueOn: day(row.dueOn) }, today),
      ).length,
      costGrowthPct: growthPct,
      paymentsOverdue: overdueRows.length,
    };
    return {
      today,
      health: projectHealth(facts, thresholds),
      progress: {
        workPct: progress.work.pct,
        plannedPct: progress.planned.pct,
        variance: progress.planned.variance,
      },
      milestones: {
        achieved: planned.milestones.filter((row) => row.status === 'achieved')
          .length,
        total: planned.milestones.filter((row) => row.status !== 'cancelled')
          .length,
        late: late.map((row) => ({
          title: row.title,
          dueOn: row.dueOn,
          forecast: row.forecast,
        })),
      },
      risks: {
        open: risks.length,
        high: facts.risksHigh,
        critical: facts.risksCritical,
      },
      issues: { open: issues.length, overdue: facts.issuesOverdue },
      budget: current
        ? {
            versionNo: current.versionNo,
            total: Number(current.total),
            firstTotal,
            growthPct,
          }
        : null,
      payments: {
        scheduled: payments.totals.scheduled,
        received: payments.totals.received,
        outstanding: payments.totals.outstanding,
        overdue: payments.totals.overdue,
        overdueCount: overdueRows.length,
      },
    };
  }

  // --- reports ----------------------------------------------------------------------

  async list(projectId: string, actor: Principal, now = new Date()) {
    const access = await this.projects.access(projectId, actor);
    const [live, rows] = await Promise.all([
      this.snapshot(access, actor, now),
      this.rows(projectId),
    ]);
    const names = await this.displayNames(rows.map((row) => row.submittedBy));
    const thisWeek = weekStart(bangkokDay(now));
    return {
      canEdit: access.canEdit,
      thisWeek,
      live,
      reports: rows.map((row) => ({
        id: row.id,
        weekStart: day(row.weekStart),
        status: row.status,
        healthLevel: row.healthLevel,
        healthScore: row.healthScore,
        snapshot: row.snapshot as StatusSnapshot,
        snapshotAt: row.snapshotAt,
        accomplished: row.accomplished,
        nextSteps: row.nextSteps,
        helpNeeded: row.helpNeeded,
        submittedAt: row.submittedAt,
        submittedByName: row.submittedBy
          ? (names.get(row.submittedBy) ?? null)
          : null,
      })),
    };
  }

  /** This week's draft, made now or its figures brought up to date. */
  async draft(projectId: string, actor: Principal, now = new Date()) {
    const access = await this.editable(projectId, actor);
    const week = weekStart(bangkokDay(now));
    const current = (await this.reports.findFirst({
      where: { projectId, weekStart: asDate(week) },
    })) as ReportRow | null;
    if (current?.status === 'submitted') {
      throw new AppError('CONFLICT', 'ส่งรายงานสัปดาห์นี้แล้ว');
    }
    await this.writeDraft(access, actor, now);
    return this.list(projectId, actor, now);
  }

  async update(
    projectId: string,
    reportId: string,
    dto: SaveStatusReportDto,
    actor: Principal,
    now = new Date(),
  ) {
    const access = await this.editable(projectId, actor);
    const row = await this.requireDraft(projectId, reportId);
    const data = {
      accomplished:
        dto.accomplished === undefined
          ? undefined
          : dto.accomplished.trim() || null,
      nextSteps:
        dto.next_steps === undefined
          ? undefined
          : dto.next_steps.trim() || null,
      helpNeeded:
        dto.help_needed === undefined
          ? undefined
          : dto.help_needed.trim() || null,
    };
    await this.transactions.execute(async (prisma) => {
      await this.reports.update(
        { where: { id: row.id }, data: { ...data, updatedBy: actor.userId } },
        { prisma },
      );
      await this.audit.record(
        {
          eventType: 'pm.status_report.saved',
          companyId: access.project.companyId,
          ...auditActor(actor),
          resourceType: 'project',
          resourceId: projectId,
          after: { reportId, ...data },
        },
        { prisma },
      );
    });
    return this.list(projectId, actor, now);
  }

  /** Sent: the figures as of now, frozen with the manager's words. */
  async submit(
    projectId: string,
    reportId: string,
    actor: Principal,
    now = new Date(),
  ) {
    const access = await this.editable(projectId, actor);
    const row = await this.requireDraft(projectId, reportId);
    if (!row.accomplished?.trim() || !row.nextSteps?.trim()) {
      throw new AppError(
        'VALIDATION_FAILED',
        'ต้องกรอกงานที่ทำได้ในสัปดาห์นี้ และงานสัปดาห์ถัดไป ก่อนส่งรายงาน',
      );
    }
    const snapshot = await this.snapshot(access, actor, now);
    await this.transactions.execute(async (prisma) => {
      const claimed = await prisma.projectStatusReport.updateMany({
        where: { id: row.id, status: 'draft' },
        data: {
          status: 'submitted',
          ...this.figures(snapshot, now),
          submittedAt: now,
          submittedBy: actor.userId,
          updatedBy: actor.userId,
        },
      });
      if (!claimed.count) throw new AppError('CONFLICT', 'ส่งรายงานนี้แล้ว');
      await this.audit.record(
        {
          eventType: 'pm.status_report.submitted',
          companyId: access.project.companyId,
          ...auditActor(actor),
          resourceType: 'project',
          resourceId: projectId,
          after: {
            reportId,
            weekStart: day(row.weekStart),
            health: snapshot.health.level,
            score: snapshot.health.score,
          },
        },
        { prisma },
      );
    });
    return this.list(projectId, actor, now);
  }

  // --- portfolio ----------------------------------------------------------------------

  /** Every running project the caller sees, the most at risk first. */
  async portfolio(actor: Principal, now = new Date()) {
    const projects = await this.projects.runningVisible(actor);
    const week = weekStart(bangkokDay(now));
    const latest = (await this.reports.findMany({
      where: {
        projectId: { in: projects.map((row) => row.id) },
        weekStart: asDate(week),
      },
      select: { projectId: true, status: true },
    })) as { projectId: string; status: string }[];
    const names = await this.displayNames(
      projects.map((row) => row.managerUserId),
    );
    const rows: {
      id: string;
      projectNo: string;
      name: string;
      status: string;
      customerName: string | null;
      managerName: string | null;
      endOn: string;
      contractValue: number | null;
      health: Health;
      progress: StatusSnapshot['progress'];
      paymentsOverdue: number;
      reportStatus: string | null;
    }[] = [];
    for (let at = 0; at < projects.length; at += PORTFOLIO_BATCH) {
      const batch = projects.slice(at, at + PORTFOLIO_BATCH);
      const computed = await Promise.all(
        batch.map(async (project) => {
          const access = await this.projects.access(project.id, actor);
          return this.snapshot(access, actor, now);
        }),
      );
      batch.forEach((project, index) => {
        const snapshot = computed[index];
        rows.push({
          id: project.id,
          projectNo: project.projectNo,
          name: project.name,
          status: project.status,
          customerName:
            project.contract.customer?.nameTh ??
            project.contract.counterpartyName,
          managerName: names.get(project.managerUserId) ?? null,
          endOn: day(project.endOn),
          contractValue:
            project.contractValue === null
              ? null
              : Number(project.contractValue),
          health: snapshot.health,
          progress: snapshot.progress,
          paymentsOverdue: snapshot.payments.overdue,
          reportStatus:
            latest.find((row) => row.projectId === project.id)?.status ?? null,
        });
      });
    }
    const sorted = byRisk(rows);
    const thresholds = await this.thresholds(actor.activeCompanyId);
    return {
      thisWeek: week,
      thresholds,
      counts: {
        red: sorted.filter((row) => row.health.level === 'red').length,
        amber: sorted.filter((row) => row.health.level === 'amber').length,
        green: sorted.filter((row) => row.health.level === 'green').length,
        unreported: sorted.filter((row) => row.reportStatus !== 'submitted')
          .length,
      },
      projects: sorted,
    };
  }

  // --- the weekly drafts -------------------------------------------------------------

  /**
   * Every running project has this week's draft; a draft's figures are
   * brought up to date once a Bangkok day. Run as the project's manager,
   * whose report it is. Returns how many drafts were made.
   */
  async sweep(now = new Date()) {
    const today = bangkokDay(now);
    const week = weekStart(today);
    let made = 0;
    for (const project of await this.projects.allRunning()) {
      try {
        const current = (await this.reports.findFirst({
          where: { projectId: project.id, weekStart: asDate(week) },
          select: { status: true, snapshotAt: true },
        })) as { status: string; snapshotAt: Date } | null;
        if (current?.status === 'submitted') continue;
        if (current && bangkokDay(current.snapshotAt) === today) continue;
        const manager = this.managerOf(project);
        const access = await this.projects.access(project.id, manager);
        await this.writeDraft(access, manager, now);
        if (!current) {
          made++;
          await this.notifications
            .statusReportDue(project.managerUserId, project.companyId, {
              id: project.id,
              projectNo: access.project.projectNo,
              name: access.project.name,
            })
            .catch(() => undefined);
        }
      } catch (error) {
        this.logger.warn(
          `status report for ${project.id} not drafted: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return made;
  }

  // --- helpers -----------------------------------------------------------------------

  private async writeDraft(access: Access, actor: Principal, now: Date) {
    const week = asDate(weekStart(bangkokDay(now)));
    const snapshot = await this.snapshot(access, actor, now);
    const figures = this.figures(snapshot, now);
    await this.reports.upsert({
      where: {
        projectId_weekStart: { projectId: access.project.id, weekStart: week },
      },
      create: {
        companyId: access.project.companyId,
        projectId: access.project.id,
        weekStart: week,
        ...figures,
      },
      update: figures,
    });
  }

  private figures(snapshot: StatusSnapshot, now: Date) {
    return {
      healthLevel: snapshot.health.level,
      healthScore: snapshot.health.score,
      workPct: snapshot.progress.workPct,
      plannedPct: snapshot.progress.plannedPct,
      snapshot: snapshot as unknown as Prisma.InputJsonValue,
      snapshotAt: now,
    };
  }

  private async thresholds(companyId: string) {
    const row = (await this.configs.findFirst({
      where: { companyId },
      select: { projectHealthAmber: true, projectHealthRed: true },
    })) as { projectHealthAmber: number; projectHealthRed: number } | null;
    return healthThresholds(
      row?.projectHealthAmber ?? null,
      row?.projectHealthRed ?? null,
    );
  }

  private async editable(projectId: string, actor: Principal) {
    const access = await this.projects.access(projectId, actor);
    if (!access.canEdit) {
      throw new AppError(
        'FORBIDDEN',
        'รายงานสถานะได้เฉพาะผู้จัดการโครงการ หรือผู้มีสิทธิ์จัดการโครงการ ขณะโครงการยังดำเนินอยู่',
      );
    }
    return access;
  }

  private async requireDraft(projectId: string, reportId: string) {
    const row = (await this.reports.findFirst({
      where: { id: reportId, projectId },
    })) as ReportRow | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบรายงาน');
    if (row.status !== 'draft') {
      throw new AppError('CONFLICT', 'ส่งรายงานนี้แล้ว แก้ไขไม่ได้');
    }
    return row;
  }

  private async rows(projectId: string) {
    return (await this.reports.findMany({
      where: { projectId },
      orderBy: { weekStart: 'desc' },
      take: 26,
    })) as ReportRow[];
  }

  /** The manager, as the one the weekly draft is written for. */
  private managerOf(project: { companyId: string; managerUserId: string }) {
    return {
      userId: project.managerUserId,
      keycloakId: '',
      username: 'system',
      displayName: 'system',
      email: null,
      companies: [],
      activeCompanyId: project.companyId,
      orgUnitId: null,
      supervisorUserId: null,
      ledUnitIds: [],
      levelUnitIds: [],
      scopedUnitIds: [],
      permissions: [],
    } as unknown as Principal;
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
