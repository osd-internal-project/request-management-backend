import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import {
  AppError,
  AuditWriter,
  auditActor,
  hasPermission,
  Principal,
  PrismaTransactionService,
} from '@request-management/share';
import { backgroundTick } from '../common/background-tick';
import { thaiToday } from '../crm/vendor-costs';
import { NotificationRulesService } from '../notifications/notification-rules.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  ProjectMilestoneRepository,
  ProjectRepository,
} from '../pm/project.repositories';
import { ProjectsService } from '../pm/projects.service';
import { readBoq } from '../presales/solution-rules';
import { ListDeliveriesQueryDto, SaveDeliveryDto } from './delivery.dto';
import {
  type BoqRef,
  boqCoverage,
  DEFAULT_WARN_DAYS,
  deliveryProblems,
  deliveryReadiness,
  needsWarning,
} from './delivery-rules';
import {
  DeliveryPeopleRepository,
  ProjectDeliveryLineRepository,
  ProjectDeliveryRepository,
} from './delivery.repositories';

const RULE = 'delivery.readiness';
const DEFAULT_INTERVAL_MS = 6 * 3_600_000;
const day = (value: Date) => value.toISOString().slice(0, 10);
const date = (value: string) => new Date(`${value}T00:00:00Z`);

interface DeliveryRow {
  id: string;
  companyId: string;
  projectId: string;
  milestoneId: string;
  seq: number;
  plannedOn: Date;
  location: string;
  receiverName: string;
  receiverPhone: string;
  note: string;
  status: string;
  warnedFor: Date | null;
  createdAt: Date;
  createdBy: string;
  updatedAt: Date;
  lines: {
    id: string;
    boqIndex: number;
    quantity: Prisma.Decimal;
    readiness: string;
    readyQty: Prisma.Decimal | null;
    expectedOn: Date | null;
    fallbackPlan: string;
    note: string;
  }[];
}

interface ProjectRow {
  id: string;
  companyId: string;
  projectNo: string;
  name: string;
  status: string;
  managerUserId: string;
  baseline: unknown;
}

/**
 * CD-250 แผนส่งมอบ (part of CD-20 Delivery).
 *
 * A milestone is delivered in one or more trips: when, where, who receives,
 * and which BOQ lines of the project's baseline in what quantity — never
 * more of a line, across all live trips, than the BOQ holds. Each line says
 * whether the goods are ready (typed in until SAP stock can be read, CD-28);
 * a line not ready, or only partly, carries a fallback plan. Within the
 * company's `delivery.readiness` days (CD-53, standard 7) before the date,
 * a trip with a line not ready warns the project manager and the delivery
 * team, once for that date.
 *
 * Who: the delivery team (`delivery.read` / `delivery.manage`) every
 * project; the project's team reads its own; `delivery.manage`,
 * `pm.project.manage` or the project's manager plans, while it runs.
 */
@Injectable()
export class DeliveriesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DeliveriesService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly deliveries: ProjectDeliveryRepository,
    private readonly lines: ProjectDeliveryLineRepository,
    private readonly people: DeliveryPeopleRepository,
    private readonly projects: ProjectsService,
    private readonly projectRows: ProjectRepository,
    private readonly milestones: ProjectMilestoneRepository,
    private readonly rules: NotificationRulesService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const interval =
      this.config.get<number>('delivery.readinessIntervalMs') ??
      DEFAULT_INTERVAL_MS;
    if (interval <= 0) return;
    this.timer = setInterval(
      backgroundTick(this.logger, 'CD-250 delivery readiness', () =>
        this.sweep(),
      ),
      interval,
    );
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The delivery team's board: every trip in a window, the unready first. */
  async list(actor: Principal, query: ListDeliveriesQueryDto) {
    const companyId = actor.activeCompanyId;
    const today = thaiToday();
    const rows = (await this.deliveries.findMany({
      where: {
        companyId,
        status: query.status ?? 'planned',
        ...(query.from || query.to
          ? {
              plannedOn: {
                ...(query.from ? { gte: date(query.from) } : {}),
                ...(query.to ? { lte: date(query.to) } : {}),
              },
            }
          : {}),
      },
      include: { lines: true },
      orderBy: [{ plannedOn: 'asc' }, { seq: 'asc' }],
      take: 500,
    })) as unknown as DeliveryRow[];
    const projectIds = [...new Set(rows.map((row) => row.projectId))];
    const milestoneIds = [...new Set(rows.map((row) => row.milestoneId))];
    const [projects, milestones, rule] = await Promise.all([
      this.projectRows.findMany({
        where: { id: { in: projectIds } },
        select: PROJECT_SELECT,
      }) as unknown as Promise<ProjectRow[]>,
      this.milestones.findMany({
        where: { id: { in: milestoneIds } },
        select: { id: true, seq: true, title: true },
      }) as unknown as Promise<{ id: string; seq: number; title: string }[]>,
      this.rules.across(RULE).then((r) => r.of(companyId)),
    ]);
    const warnDays = warnDaysOf(rule);
    const byProject = new Map(projects.map((p) => [p.id, p]));
    const byMilestone = new Map(milestones.map((m) => [m.id, m]));
    return {
      today,
      warnDays,
      items: rows.map((row) => {
        const project = byProject.get(row.projectId);
        const boq = boqOf(project?.baseline);
        const view = deliveryView(row, boq);
        return {
          ...view,
          project: project
            ? {
                id: project.id,
                label: `${project.projectNo} · ${project.name}`,
                managerUserId: project.managerUserId,
              }
            : null,
          milestone: byMilestone.get(row.milestoneId) ?? null,
          warning: needsWarning(view, today, warnDays),
        };
      }),
    };
  }

  /** One project's plan: its trips, its milestones, the BOQ covered. */
  async project(actor: Principal, projectId: string) {
    const { project, canEdit } = await this.access(actor, projectId);
    const today = thaiToday();
    const [rows, milestones, rule] = await Promise.all([
      this.rows(project.id),
      this.milestones.findMany({
        where: { projectId: project.id, status: { not: 'cancelled' } },
        select: { id: true, seq: true, title: true, dueOn: true, status: true },
        orderBy: { seq: 'asc' },
      }) as unknown as Promise<
        {
          id: string;
          seq: number;
          title: string;
          dueOn: Date | null;
          status: string;
        }[]
      >,
      this.rules.across(RULE).then((r) => r.of(project.companyId)),
    ]);
    const warnDays = warnDaysOf(rule);
    const boq = boqOf(project.baseline);
    const views = rows.map((row) => deliveryView(row, boq));
    return {
      project: {
        id: project.id,
        label: `${project.projectNo} · ${project.name}`,
        status: project.status,
      },
      canEdit,
      today,
      warnDays,
      milestones: milestones.map((m) => ({
        id: m.id,
        seq: m.seq,
        title: m.title,
        dueOn: m.dueOn ? day(m.dueOn) : null,
        status: m.status,
      })),
      boq: boqCoverage(
        boq,
        views.filter((v) => v.status !== 'cancelled').flatMap((v) => v.lines),
      ),
      deliveries: views.map((view) => ({
        ...view,
        warning: needsWarning(view, today, warnDays),
      })),
    };
  }

  async create(actor: Principal, projectId: string, dto: SaveDeliveryDto) {
    const { project } = await this.editable(actor, projectId);
    const clean = await this.clean(project, dto, null);
    const created = await this.transactions.execute(async (prisma) => {
      const last = await prisma.projectDelivery.findFirst({
        where: { projectId: project.id },
        orderBy: { seq: 'desc' },
        select: { seq: true },
      });
      const row = await prisma.projectDelivery.create({
        data: {
          companyId: project.companyId,
          projectId: project.id,
          seq: (last?.seq ?? 0) + 1,
          ...clean.head,
          createdBy: actor.userId,
          lines: { create: clean.lines },
        },
        select: { id: true, seq: true },
      });
      await this.audit.record(
        {
          eventType: 'delivery.planned',
          companyId: project.companyId,
          ...auditActor(actor),
          resourceType: 'project_delivery',
          resourceId: row.id,
          after: { projectId: project.id, seq: row.seq, ...auditOf(clean) },
        },
        { prisma },
      );
      return row;
    });
    return this.one(project, created.id);
  }

  async update(actor: Principal, id: string, dto: SaveDeliveryDto) {
    const existing = await this.requireDelivery(actor, id);
    const { project } = await this.editable(actor, existing.projectId);
    if (existing.status !== 'planned') {
      throw new AppError('CONFLICT', 'รอบส่งนี้ไม่ได้อยู่ในแผนแล้ว แก้ไม่ได้');
    }
    const clean = await this.clean(project, dto, existing.id);
    await this.transactions.execute(async (prisma) => {
      await prisma.projectDeliveryLine.deleteMany({
        where: { deliveryId: id },
      });
      await prisma.projectDelivery.update({
        where: { id },
        data: {
          ...clean.head,
          updatedBy: actor.userId,
          // A new date warns again.
          ...(day(existing.plannedOn) !==
          clean.head.plannedOn.toISOString().slice(0, 10)
            ? { warnedFor: null }
            : {}),
          lines: { create: clean.lines },
        },
      });
      await this.audit.record(
        {
          eventType: 'delivery.replanned',
          companyId: project.companyId,
          ...auditActor(actor),
          resourceType: 'project_delivery',
          resourceId: id,
          before: {
            plannedOn: day(existing.plannedOn),
            lines: existing.lines.length,
          },
          after: auditOf(clean),
        },
        { prisma },
      );
    });
    return this.one(project, id);
  }

  async cancel(actor: Principal, id: string, reason: string) {
    const existing = await this.requireDelivery(actor, id);
    const { project } = await this.editable(actor, existing.projectId);
    if (existing.status !== 'planned') {
      throw new AppError('CONFLICT', 'รอบส่งนี้ไม่ได้อยู่ในแผนแล้ว');
    }
    if (!reason.trim()) {
      throw new AppError('VALIDATION_FAILED', 'ต้องระบุเหตุผลที่ยกเลิก');
    }
    await this.deliveries.update({
      where: { id },
      data: {
        status: 'cancelled',
        note: [existing.note, `ยกเลิก: ${reason.trim()}`]
          .filter(Boolean)
          .join('\n'),
        updatedBy: actor.userId,
      },
    });
    await this.audit.record({
      eventType: 'delivery.cancelled',
      companyId: project.companyId,
      ...auditActor(actor),
      resourceType: 'project_delivery',
      resourceId: id,
      after: { reason: reason.trim() },
    });
    return this.one(project, id);
  }

  /**
   * The readiness pass: trips planned within the company's warning days with
   * a line not ready tell the project manager and the delivery team — once
   * for each planned date.
   */
  async sweep(now: Date = new Date()): Promise<{ warned: number }> {
    const rule = await this.rules.across(RULE);
    const enabled = [rule.standard, ...rule.byCompany.values()].filter(
      (r) => r.enabled,
    );
    if (!enabled.length) return { warned: 0 };
    const widest = Math.max(...enabled.map(warnDaysOf));
    const today = thaiToday(now);
    const until = new Date(date(today).getTime() + widest * 86_400_000);
    const rows = (await this.deliveries.findMany({
      where: {
        status: 'planned',
        plannedOn: { gte: date(today), lte: until },
        lines: { some: { readiness: { not: 'ready' } } },
      },
      include: { lines: true },
    })) as unknown as DeliveryRow[];
    let warned = 0;
    const team = new Map<string, string[]>();
    for (const row of rows) {
      const own = rule.of(row.companyId);
      if (!own.enabled) continue;
      if (row.warnedFor && day(row.warnedFor) === day(row.plannedOn)) continue;
      const view = deliveryView(row, []);
      if (!needsWarning(view, today, warnDaysOf(own))) continue;
      // Claim it first, so two passes never both send.
      const claimed = await this.deliveries.updateMany({
        where: {
          id: row.id,
          OR: [{ warnedFor: null }, { warnedFor: { not: row.plannedOn } }],
        },
        data: { warnedFor: row.plannedOn },
      });
      if (!claimed.count) continue;
      const project = (await this.projectRows.findFirst({
        where: { id: row.projectId },
        select: PROJECT_SELECT,
      })) as unknown as ProjectRow | null;
      if (!project) continue;
      if (!team.has(row.companyId)) {
        team.set(
          row.companyId,
          await this.people.holdersOf(row.companyId, 'delivery.manage'),
        );
      }
      const notReady = view.lines.filter((l) => l.readiness !== 'ready').length;
      for (const userId of new Set([
        project.managerUserId,
        ...(team.get(row.companyId) ?? []),
      ])) {
        await this.notifications.deliveryNotReady(
          userId,
          row.companyId,
          {
            id: row.id,
            projectId: project.id,
            label: `${project.projectNo} · ${project.name}`,
            seq: row.seq,
          },
          day(row.plannedOn),
          notReady,
        );
      }
      warned += 1;
    }
    return { warned };
  }

  // --- helpers ----------------------------------------------------------------

  /** Who may see (and plan) a project's delivery — shared with CD-251. */
  async access(actor: Principal, projectId: string) {
    const project = (await this.projectRows.findFirst({
      where: { id: projectId, companyId: actor.activeCompanyId },
      select: PROJECT_SELECT,
    })) as unknown as ProjectRow | null;
    if (!project) throw new AppError('NOT_FOUND', 'ไม่พบโครงการที่ระบุ');
    const team =
      hasPermission(actor, 'delivery.read') ||
      hasPermission(actor, 'delivery.manage');
    // Otherwise the project's own visibility rules (404 when not on it).
    if (!team) await this.projects.access(projectId, actor);
    const running = project.status === 'active' || project.status === 'on_hold';
    return {
      project,
      canEdit:
        running &&
        (hasPermission(actor, 'delivery.manage') ||
          hasPermission(actor, 'pm.project.manage') ||
          project.managerUserId === actor.userId),
    };
  }

  private async editable(actor: Principal, projectId: string) {
    const result = await this.access(actor, projectId);
    if (!result.canEdit) {
      throw new AppError(
        'FORBIDDEN',
        'แก้แผนส่งมอบได้เฉพาะทีม Delivery หรือผู้จัดการโครงการ ขณะโครงการดำเนินอยู่',
      );
    }
    return result;
  }

  private async requireDelivery(actor: Principal, id: string) {
    const row = (await this.deliveries.findFirst({
      where: { id, companyId: actor.activeCompanyId },
      include: { lines: true },
    })) as unknown as DeliveryRow | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบรอบส่งที่ระบุ');
    return row;
  }

  private rows(projectId: string) {
    return this.deliveries.findMany({
      where: { projectId },
      include: { lines: { orderBy: { boqIndex: 'asc' } } },
      orderBy: [{ plannedOn: 'asc' }, { seq: 'asc' }],
    }) as unknown as Promise<DeliveryRow[]>;
  }

  private async one(project: ProjectRow, id: string) {
    const row = (await this.deliveries.findFirst({
      where: { id },
      include: { lines: { orderBy: { boqIndex: 'asc' } } },
    })) as unknown as DeliveryRow;
    return deliveryView(row, boqOf(project.baseline));
  }

  /** The DTO checked and shaped for the database; problems refuse it. */
  private async clean(
    project: ProjectRow,
    dto: SaveDeliveryDto,
    selfId: string | null,
  ) {
    const milestone = await this.milestones.findFirst({
      where: { id: dto.milestone_id, projectId: project.id },
      select: { id: true, status: true },
    });
    if (
      !milestone ||
      (milestone as { status: string }).status === 'cancelled'
    ) {
      throw new AppError('VALIDATION_FAILED', 'หมุดหมายไม่อยู่ในโครงการนี้');
    }
    const boq = boqOf(project.baseline);
    const lines = dto.lines.map((line) => ({
      boqIndex: line.boq_index,
      quantity: line.quantity,
      readiness: line.readiness ?? 'unknown',
      readyQty: line.readiness === 'partial' ? (line.ready_qty ?? null) : null,
      expectedOn: line.expected_on ?? null,
      fallbackPlan: line.fallback_plan?.trim() ?? '',
      note: line.note?.trim() ?? '',
    }));
    const problems = deliveryProblems({
      plannedOn: dto.planned_on,
      location: dto.location,
      lines,
      boq,
    });
    if (!problems.length) {
      // Across every live trip of the project, no BOQ line goes over.
      const others = (await this.lines.findMany({
        where: {
          delivery: {
            projectId: project.id,
            status: { not: 'cancelled' },
            ...(selfId ? { id: { not: selfId } } : {}),
          },
        },
        select: { boqIndex: true, quantity: true },
      })) as { boqIndex: number; quantity: Prisma.Decimal }[];
      for (const row of boqCoverage(boq, [
        ...others.map((o) => ({
          boqIndex: o.boqIndex,
          quantity: Number(o.quantity),
        })),
        ...lines,
      ])) {
        if (row.over) {
          problems.push(
            `${row.label}: รวมทุกรอบ ${row.planned} เกินจำนวนใน BOQ (${row.quantity})`,
          );
        }
      }
    }
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'lines', reason })),
      );
    }
    return {
      head: {
        milestoneId: milestone.id,
        plannedOn: date(dto.planned_on),
        location: dto.location.trim(),
        receiverName: dto.receiver_name?.trim() ?? '',
        receiverPhone: dto.receiver_phone?.trim() ?? '',
        note: dto.note?.trim() ?? '',
      },
      lines: lines.map((line) => ({
        ...line,
        expectedOn: line.expectedOn ? date(line.expectedOn) : null,
      })),
    };
  }
}

const PROJECT_SELECT = {
  id: true,
  companyId: true,
  projectNo: true,
  name: true,
  status: true,
  managerUserId: true,
  baseline: true,
} as const;

function boqOf(baseline: unknown): BoqRef[] {
  return readBoq((baseline as { boq?: unknown } | null)?.boq).map(
    (line, index) => ({
      index,
      label: `BOQ ${index + 1}: ${line.name || line.productCode}`,
      quantity: line.quantity,
      unit: line.unit || null,
    }),
  );
}

function warnDaysOf(rule: { params: Record<string, unknown> }) {
  const days = rule.params.days;
  return typeof days === 'number' ? days : DEFAULT_WARN_DAYS;
}

function deliveryView(row: DeliveryRow, boq: BoqRef[]) {
  const lines = row.lines.map((line) => ({
    id: line.id,
    boqIndex: line.boqIndex,
    label:
      boq.find((b) => b.index === line.boqIndex)?.label ??
      `BOQ ${line.boqIndex + 1}`,
    unit: boq.find((b) => b.index === line.boqIndex)?.unit ?? null,
    quantity: Number(line.quantity),
    readiness: line.readiness,
    readyQty: line.readyQty === null ? null : Number(line.readyQty),
    expectedOn: line.expectedOn ? day(line.expectedOn) : null,
    fallbackPlan: line.fallbackPlan,
    note: line.note,
  }));
  return {
    id: row.id,
    projectId: row.projectId,
    milestoneId: row.milestoneId,
    seq: row.seq,
    plannedOn: day(row.plannedOn),
    location: row.location,
    receiverName: row.receiverName,
    receiverPhone: row.receiverPhone,
    note: row.note,
    status: row.status,
    readiness: deliveryReadiness(lines),
    lines,
  };
}

function auditOf(clean: {
  head: { plannedOn: Date; milestoneId: string };
  lines: { boqIndex: number; quantity: number; readiness: string }[];
}) {
  return {
    plannedOn: clean.head.plannedOn.toISOString().slice(0, 10),
    milestoneId: clean.head.milestoneId,
    lines: clean.lines
      .map((l) => `${l.boqIndex}:${l.quantity}:${l.readiness}`)
      .join(','),
  };
}
