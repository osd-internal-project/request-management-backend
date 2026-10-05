import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AppError,
  AuditWriter,
  auditActor,
  OBJECT_STORAGE,
  Principal,
  PrismaTransactionService,
} from '@request-management/share';
import type { ObjectStorage } from '@request-management/share';
import { CompanyMemberRepository } from '../access/company-member.repository';
import { backgroundTick } from '../common/background-tick';
import { CompanyRepository } from '../crm/product.repositories';
import { CrmConfigRepository } from '../crm/segment.repositories';
import { thaiToday } from '../crm/vendor-costs';
import { ERP_CLIENT } from '../erp/erp-client';
import type { ErpClient } from '../erp/erp-client';
import { HrRatesService } from '../hr/hr-rates.service';
import { TimesheetsService } from '../hr/timesheets.service';
import { NotificationsService } from '../notifications/notifications.service';
import { safeFileName } from '../requests/attachments.service';
import { budgetTotals, BudgetLine } from './budget-rules';
import {
  compareCosts,
  costEntryProblems,
  DEFAULT_COST_ALERT_PCT,
  DEFAULT_COST_WARN_PCT,
  laborCost,
  newCrossings,
} from './cost-rules';
import { AddProjectCostDto } from './dto/project.dto';
import { EVIDENCE_TYPES, MAX_EVIDENCE_BYTES } from './milestones.service';
import {
  ProjectBudgetRepository,
  ProjectCostAlertRepository,
  ProjectCostRepository,
  ProjectRepository,
} from './project.repositories';
import { ProjectsService } from './projects.service';

interface CostRow {
  id: string;
  category: string;
  source: string;
  erpKey: string | null;
  docNo: string | null;
  description: string;
  amount: unknown;
  incurredOn: Date;
  vendorName: string | null;
  evidenceName: string | null;
  createdBy: string;
}

interface UploadedFile {
  readonly originalname: string;
  readonly mimetype: string;
  readonly size: number;
  readonly buffer: Buffer;
}

const day = (value: Date) => value.toISOString().slice(0, 10);
const LABEL: Record<string, string> = {
  material: 'วัสดุ/อุปกรณ์',
  labor: 'แรงงาน',
  other: 'อื่น ๆ',
  total: 'รวม',
};

/**
 * CD-190 ติดตามต้นทุนโครงการ — actual cost against the locked reference
 * budget (CD-179), per category and in total: labour from approved
 * timesheets (CD-231) at the cost rate of each day (CD-207); material and
 * other from the ERP by project code, plus what the manager records with its
 * evidence. Crossing the company's thresholds (CRM settings: warn at 90%,
 * alert over 100%) tells the manager and everyone holding
 * `pricing.price.read`, once per level and budget version. A background
 * pass syncs the ERP and checks every running project.
 *
 * Who: whoever sees the project reads it; the manager records entries and
 * asks for a sync.
 */
@Injectable()
export class ProjectCostsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProjectCostsService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly projects: ProjectsService,
    private readonly projectRows: ProjectRepository,
    private readonly budgets: ProjectBudgetRepository,
    private readonly costs: ProjectCostRepository,
    private readonly alerts: ProjectCostAlertRepository,
    private readonly companies: CompanyRepository,
    private readonly configs: CrmConfigRepository,
    private readonly timesheets: TimesheetsService,
    private readonly rates: HrRatesService,
    @Inject(ERP_CLIENT) private readonly erp: ErpClient,
    private readonly people: CompanyMemberRepository,
    private readonly notifications: NotificationsService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const everyMs =
      this.config.get<number>('pm.costSweepIntervalMs') ?? 21_600_000;
    // `0` disables — tests never sweep.
    if (everyMs <= 0) return;
    const tick = backgroundTick(this.logger, 'project cost sweep', () =>
      this.sweep(),
    );
    this.timer = setInterval(tick, everyMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async view(projectId: string, actor: Principal) {
    const access = await this.projects.access(projectId, actor);
    const state = await this.state(projectId, access.project.companyId);
    const entries = await this.entryRows(projectId);
    const names = await this.displayNames(entries.map((row) => row.createdBy));
    return {
      canEdit: access.canEdit,
      ...state,
      entries: entries.map((row) => ({
        id: row.id,
        category: row.category,
        source: row.source,
        docNo: row.docNo,
        description: row.description,
        amount: Number(row.amount),
        incurredOn: day(row.incurredOn),
        vendorName: row.vendorName,
        evidenceName: row.evidenceName,
        createdByName:
          row.source === 'manual' ? (names.get(row.createdBy) ?? null) : null,
      })),
    };
  }

  /** Actual against budget — for the card and the sweep. */
  async state(projectId: string, companyId: string) {
    const [budget, entries, actuals, rates, thresholds, lastSync] =
      await Promise.all([
        this.lockedBudget(projectId),
        this.entryRows(projectId),
        this.timesheets.projectActuals(companyId, projectId),
        this.rates.rateRows(companyId),
        this.thresholds(companyId),
        this.costs.findFirst({
          where: { projectId, source: 'erp' },
          orderBy: { updatedAt: 'desc' },
          select: { updatedAt: true },
        }) as Promise<{ updatedAt: Date } | null>,
      ]);
    const labor = laborCost(actuals.lines, rates);
    const sum = (category: string) =>
      Math.round(
        entries
          .filter((row) => row.category === category)
          .reduce((total, row) => total + Number(row.amount), 0) * 100,
      ) / 100;
    const budgetBy = budget
      ? budgetTotals(budget.lines, null).byCategory
      : { material: 0, labor: 0, other: 0 };
    const rows = compareCosts({
      budget: budgetBy,
      actual: {
        material: sum('material'),
        labor: labor.amount,
        other: sum('other'),
      },
      ...thresholds,
    });
    return {
      budget: budget ? { versionNo: budget.versionNo } : null,
      thresholds,
      rows,
      labor,
      lastErpSyncAt: lastSync?.updatedAt ?? null,
    };
  }

  async add(
    projectId: string,
    dto: AddProjectCostDto,
    file: UploadedFile | undefined,
    actor: Principal,
  ) {
    const access = await this.manager(projectId, actor);
    const input = {
      category: dto.category ?? '',
      description: (dto.description ?? '').trim(),
      amount: Number(dto.amount),
      incurredOn: (dto.incurred_on ?? '').trim(),
    };
    const problems = costEntryProblems({
      ...input,
      today: thaiToday(),
      hasEvidence: Boolean(file),
    });
    if (
      file &&
      !(EVIDENCE_TYPES as readonly string[]).includes(file.mimetype)
    ) {
      problems.push('แนบได้เฉพาะรูป PDF Word หรือ Excel');
    }
    if (file && file.size > MAX_EVIDENCE_BYTES) {
      problems.push('ไฟล์ใหญ่เกิน 25 MB');
    }
    if (problems.length || !file) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'cost', reason })),
      );
    }
    const id = randomUUID();
    const name = safeFileName(file.originalname);
    const key = `projects/${projectId}/costs/${id}/${name}`;
    await this.storage.put(key, file.buffer, {
      contentType: file.mimetype,
      size: file.size,
    });
    try {
      await this.transactions.execute(async (prisma) => {
        await prisma.projectCost.create({
          data: {
            id,
            companyId: access.project.companyId,
            projectId,
            category: input.category,
            source: 'manual',
            docNo: dto.doc_no?.trim() || null,
            description: input.description,
            amount: Math.round(input.amount * 100) / 100,
            incurredOn: new Date(`${input.incurredOn}T00:00:00Z`),
            vendorName: dto.vendor_name?.trim() || null,
            evidenceKey: key,
            evidenceName: name,
            evidenceMime: file.mimetype,
            evidenceSize: file.size,
            createdBy: actor.userId,
          },
        });
        await this.audit.record(
          {
            eventType: 'pm.cost.recorded',
            companyId: access.project.companyId,
            ...auditActor(actor),
            resourceType: 'project',
            resourceId: projectId,
            after: {
              costId: id,
              category: input.category,
              amount: input.amount,
              description: input.description,
            },
          },
          { prisma },
        );
      });
    } catch (error) {
      await this.storage.remove(key).catch(() => undefined);
      throw error;
    }
    await this.check(projectId, access.project.companyId).catch(
      () => undefined,
    );
    return this.view(projectId, actor);
  }

  /** A manual entry off the list (the manager); the file stays. */
  async remove(projectId: string, costId: string, actor: Principal) {
    const access = await this.manager(projectId, actor);
    const row = (await this.costs.findFirst({
      where: { id: costId, projectId, deletedAt: null },
      select: { id: true, source: true, amount: true, description: true },
    })) as {
      id: string;
      source: string;
      amount: unknown;
      description: string;
    } | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบรายการต้นทุน');
    if (row.source !== 'manual') {
      throw new AppError(
        'CONFLICT',
        'รายการจาก ERP แก้ที่ ERP — นำออกจากที่นี่ไม่ได้',
      );
    }
    await this.transactions.execute(async (prisma) => {
      await prisma.projectCost.update({
        where: { id: costId },
        data: { deletedAt: new Date(), deletedBy: actor.userId },
      });
      await this.audit.record(
        {
          eventType: 'pm.cost.removed',
          companyId: access.project.companyId,
          ...auditActor(actor),
          resourceType: 'project',
          resourceId: projectId,
          before: {
            costId,
            amount: Number(row.amount),
            description: row.description,
          },
        },
        { prisma },
      );
    });
    return this.view(projectId, actor);
  }

  async evidence(
    projectId: string,
    costId: string,
    actor: Principal,
  ): Promise<{ stream: Readable; fileName: string; mimeType: string }> {
    await this.projects.access(projectId, actor);
    const row = (await this.costs.findFirst({
      where: { id: costId, projectId, deletedAt: null },
      select: { evidenceKey: true, evidenceName: true, evidenceMime: true },
    })) as {
      evidenceKey: string | null;
      evidenceName: string | null;
      evidenceMime: string | null;
    } | null;
    if (!row?.evidenceKey) throw new AppError('NOT_FOUND', 'ไม่พบหลักฐาน');
    return {
      stream: await this.storage.get(row.evidenceKey),
      fileName: row.evidenceName ?? 'evidence',
      mimeType: row.evidenceMime ?? 'application/octet-stream',
    };
  }

  /** The manager asks for the ERP now, rather than wait for the pass. */
  async syncNow(projectId: string, actor: Principal) {
    const access = await this.manager(projectId, actor);
    try {
      await this.syncErp(projectId, access.project.companyId);
    } catch (error) {
      throw new AppError(
        'CONFLICT',
        `อ่านต้นทุนจาก ERP ไม่สำเร็จ: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await this.check(projectId, access.project.companyId);
    return this.view(projectId, actor);
  }

  /** Every running project: sync the ERP, then check the thresholds. */
  async sweep() {
    const projects = (await this.projectRows.findMany({
      where: { status: { in: ['active', 'on_hold'] } },
      select: { id: true, companyId: true },
    })) as { id: string; companyId: string }[];
    for (const project of projects) {
      try {
        await this.syncErp(project.id, project.companyId);
      } catch (error) {
        this.logger.warn(
          `project cost ERP sync ${project.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      try {
        await this.check(project.id, project.companyId);
      } catch (error) {
        this.logger.warn(
          `project cost check ${project.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /**
   * What the ERP books against the project code now: new lines in, changed
   * ones updated, lines it no longer lists off (a mock's included).
   */
  async syncErp(projectId: string, companyId: string) {
    const [project, company] = await Promise.all([
      this.projectRows.findFirst({
        where: { id: projectId },
        select: { projectNo: true },
      }) as Promise<{ projectNo: string } | null>,
      this.companies.findFirst({
        where: { id: companyId },
        select: { code: true },
      }) as Promise<{ code: string } | null>,
    ]);
    if (!project || !company) return;
    const lines = await this.erp.listProjectCosts(
      { companyCode: company.code },
      project.projectNo,
    );
    const now = new Date();
    await this.transactions.execute(async (prisma) => {
      for (const line of lines) {
        const data = {
          category: line.category,
          docNo: line.docNo,
          description: line.description.slice(0, 500),
          amount: Math.round(line.amount * 100) / 100,
          incurredOn: new Date(`${line.postedOn}T00:00:00Z`),
          vendorName: line.vendorName,
          deletedAt: null,
          deletedBy: null,
        };
        await prisma.projectCost.upsert({
          where: { projectId_erpKey: { projectId, erpKey: line.key } },
          create: {
            companyId,
            projectId,
            source: 'erp',
            erpKey: line.key,
            createdBy: 'system',
            ...data,
          },
          update: data,
        });
      }
      await prisma.projectCost.updateMany({
        where: {
          projectId,
          source: 'erp',
          deletedAt: null,
          erpKey: { notIn: lines.map((line) => line.key) },
        },
        data: { deletedAt: now, deletedBy: 'system' },
      });
      // touch, so "last synced" moves even when nothing changed
      await prisma.projectCost.updateMany({
        where: { projectId, source: 'erp', deletedAt: null },
        data: { updatedAt: now },
      });
    });
  }

  /** Thresholds newly crossed: recorded, then told. */
  async check(projectId: string, companyId: string) {
    const state = await this.state(projectId, companyId);
    if (!state.budget) return [];
    const told = (await this.alerts.findMany({
      where: { projectId, budgetVersionNo: state.budget.versionNo },
      select: { category: true, level: true },
    })) as { category: string; level: string }[];
    const fresh = newCrossings(state.rows, told);
    if (!fresh.length) return [];
    const created: typeof fresh = [];
    for (const item of fresh) {
      const claimed = await this.alerts.createMany({
        data: [
          {
            companyId,
            projectId,
            budgetVersionNo: state.budget.versionNo,
            category: item.category,
            level: item.level,
            budget: item.row.budget,
            actual: item.row.actual,
          },
        ],
        skipDuplicates: true,
      });
      if (claimed.count) created.push(item);
    }
    if (!created.length) return [];
    const project = (await this.projectRows.findFirst({
      where: { id: projectId },
      select: { id: true, projectNo: true, name: true, managerUserId: true },
    })) as {
      id: string;
      projectNo: string;
      name: string;
      managerUserId: string;
    } | null;
    if (!project) return created;
    const pricing = (await this.people.findMany({
      where: {
        status: 'ACTIVE',
        roles: {
          some: {
            companyId,
            role: {
              permissions: { some: { permissionCode: 'pricing.price.read' } },
            },
          },
        },
      },
      select: { id: true },
    })) as { id: string }[];
    const recipients = [
      ...new Set([project.managerUserId, ...pricing.map((row) => row.id)]),
    ];
    for (const item of created) {
      for (const userId of recipients) {
        await this.notifications
          .projectCostAlert(userId, companyId, {
            project,
            category: LABEL[item.category] ?? item.category,
            level: item.level,
            budget: item.row.budget,
            actual: item.row.actual,
            pct: item.row.pct,
          })
          .catch(() => undefined);
      }
    }
    return created;
  }

  // --- helpers -----------------------------------------------------------------------

  private async lockedBudget(projectId: string) {
    const row = (await this.budgets.findFirst({
      where: { projectId, status: 'locked' },
      orderBy: { versionNo: 'desc' },
      select: { versionNo: true, lines: true },
    })) as { versionNo: number; lines: unknown } | null;
    if (!row) return null;
    return {
      versionNo: row.versionNo,
      lines: (Array.isArray(row.lines) ? row.lines : []) as BudgetLine[],
    };
  }

  private async thresholds(companyId: string) {
    const row = (await this.configs.findFirst({
      where: { companyId },
      select: { projectCostWarnPct: true, projectCostAlertPct: true },
    })) as { projectCostWarnPct: number; projectCostAlertPct: number } | null;
    return {
      warnPct: row?.projectCostWarnPct ?? DEFAULT_COST_WARN_PCT,
      alertPct: row?.projectCostAlertPct ?? DEFAULT_COST_ALERT_PCT,
    };
  }

  private async entryRows(projectId: string) {
    return (await this.costs.findMany({
      where: { projectId, deletedAt: null },
      orderBy: [{ incurredOn: 'desc' }, { createdAt: 'desc' }],
      select: {
        id: true,
        category: true,
        source: true,
        erpKey: true,
        docNo: true,
        description: true,
        amount: true,
        incurredOn: true,
        vendorName: true,
        evidenceName: true,
        createdBy: true,
      },
    })) as CostRow[];
  }

  private async manager(projectId: string, actor: Principal) {
    const access = await this.projects.access(projectId, actor);
    if (!access.canEdit) {
      throw new AppError(
        'FORBIDDEN',
        'บันทึกต้นทุนได้เฉพาะผู้จัดการโครงการ หรือผู้มีสิทธิ์จัดการโครงการ',
      );
    }
    return access;
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
