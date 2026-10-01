import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  AppError,
  AuditWriter,
  auditActor,
  Principal,
  PrismaTransactionService,
} from '@request-management/share';
import { CompanyMemberRepository } from '../access/company-member.repository';
import { approvalStateOf } from '../crm/contract-terms';
import { CrmConfigRepository } from '../crm/segment.repositories';
import { DomainEventsService } from '../events/domain-events.service';
import { DOMAIN_EVENTS } from '../events/event-catalog';
import { NotificationsService } from '../notifications/notifications.service';
import { RequestRepository } from '../requests/request.repository';
import { RequestsService } from '../requests/requests.service';
import { budgetTotals, type BudgetLine } from './budget-rules';
import {
  budgetAfter,
  changeImpact,
  cleanChangeLines,
  costChangeOf,
  submitProblems,
} from './change-rules';
import { SaveChangeRequestDto } from './dto/project.dto';
import {
  ProjectBudgetRepository,
  ProjectChangeRequestRepository,
} from './project.repositories';
import { ProjectsService } from './projects.service';

interface ChangeRow {
  id: string;
  companyId: string;
  projectId: string;
  seq: number;
  title: string;
  reason: string;
  scopeAdded: string | null;
  scopeRemoved: string | null;
  scheduleDays: number;
  costLines: unknown;
  costChange: Prisma.Decimal;
  priceChange: Prisma.Decimal;
  status: string;
  requestId: string | null;
  error: string | null;
  submittedAt: Date | null;
  submittedBy: string | null;
  decidedAt: Date | null;
  budgetId: string | null;
  createdAt: Date;
  createdBy: string;
}

const readLines = (value: unknown): BudgetLine[] =>
  Array.isArray(value) ? (value as BudgetLine[]) : [];
const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * CD-185 คำขอเปลี่ยนแปลง — a change to what was sold, judged on three
 * sides: scope (added, removed), time (working days) and cost (budget lines
 * added or taken away), with the price change to the customer; the system
 * works out the new budget, value and margin. It goes to the change board
 * as a request of the type set in CRM settings (`projectChangeTypeCode`,
 * routed by its approval matrix on `cost_change`, `price_change`,
 * `margin_pct`). Approved, it writes the next budget version (CD-179) and
 * the work it adds may start (CD-181) — not before.
 *
 * Who: whoever sees the project reads them; `pm.project.manage` or the
 * project's manager raises and submits them.
 */
@Injectable()
export class ChangeRequestsService implements OnModuleInit {
  private readonly logger = new Logger(ChangeRequestsService.name);

  constructor(
    private readonly projects: ProjectsService,
    private readonly changes: ProjectChangeRequestRepository,
    private readonly budgets: ProjectBudgetRepository,
    private readonly configs: CrmConfigRepository,
    private readonly requestRows: RequestRepository,
    private readonly requests: RequestsService,
    private readonly people: CompanyMemberRepository,
    private readonly notifications: NotificationsService,
    private readonly events: DomainEventsService,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  onModuleInit(): void {
    // the change board's decision, when it lands
    for (const name of [
      DOMAIN_EVENTS.requestApproved,
      DOMAIN_EVENTS.requestCompleted,
      DOMAIN_EVENTS.requestRejected,
      DOMAIN_EVENTS.requestCancelled,
    ]) {
      this.events.on(name, (event) => {
        const payload = event.payload as { request_id?: string };
        if (!payload.request_id) return Promise.resolve();
        return this.syncRequest(payload.request_id).catch((error: Error) =>
          this.logger.warn(`change request not synced: ${error.message}`),
        );
      });
    }
  }

  async list(projectId: string, actor: Principal) {
    const { project, canEdit } = await this.projects.access(projectId, actor);
    const rows = await this.rows(projectId);
    // a decision the event did not carry (missed, or made before) is read here
    for (const row of rows.filter((item) => item.status === 'submitted')) {
      if (row.requestId) await this.syncRequest(row.requestId);
    }
    const fresh = await this.rows(projectId);
    const base = await this.budgetInForce(projectId);
    const config = (await this.configs.findFirst({
      where: { companyId: project.companyId },
      select: { projectChangeTypeCode: true },
    })) as { projectChangeTypeCode: string | null } | null;
    const requestNos = await this.requestNos(fresh.map((row) => row.requestId));
    const names = await this.displayNames(
      fresh.flatMap((row) => [row.createdBy, row.submittedBy]),
    );
    return {
      canEdit,
      typeConfigured: Boolean(config?.projectChangeTypeCode),
      budget: base
        ? {
            versionNo: base.versionNo,
            total: base.total,
            contractValue: base.contractValue,
          }
        : null,
      changes: fresh.map((row) =>
        this.present(row, base, names, requestNos.get(row.requestId ?? '')),
      ),
    };
  }

  async create(projectId: string, dto: SaveChangeRequestDto, actor: Principal) {
    const { project } = await this.editable(projectId, actor);
    const fields = this.fieldsOf(dto, null);
    const created = await this.transactions.execute(async (prisma) => {
      const last = (await this.changes.findFirst(
        {
          where: { projectId },
          orderBy: { seq: 'desc' },
          select: { seq: true },
        },
        { prisma },
      )) as { seq: number } | null;
      const row = (await this.changes.create(
        {
          data: {
            companyId: project.companyId,
            projectId,
            seq: (last?.seq ?? 0) + 1,
            ...fields,
            createdBy: actor.userId,
          },
          select: { id: true, seq: true },
        },
        { prisma },
      )) as { id: string; seq: number };
      await this.audit.record(
        {
          eventType: 'pm.change.created',
          companyId: project.companyId,
          ...auditActor(actor),
          resourceType: 'project_change_request',
          resourceId: row.id,
          after: { projectId, seq: row.seq, title: fields.title },
        },
        { prisma },
      );
      return row;
    });
    return { ...(await this.list(projectId, actor)), changeId: created.id };
  }

  async update(
    projectId: string,
    changeId: string,
    dto: SaveChangeRequestDto,
    actor: Principal,
  ) {
    const { project } = await this.editable(projectId, actor);
    const current = await this.requireChange(projectId, changeId);
    if (current.status !== 'draft') {
      throw new AppError('CONFLICT', 'แก้ได้เฉพาะคำขอที่ยังเป็นร่าง');
    }
    const fields = this.fieldsOf(dto, current);
    await this.transactions.execute(async (prisma) => {
      await this.changes.update(
        {
          where: { id: changeId },
          data: { ...fields, updatedBy: actor.userId },
        },
        { prisma },
      );
      await this.audit.record(
        {
          eventType: 'pm.change.updated',
          companyId: project.companyId,
          ...auditActor(actor),
          resourceType: 'project_change_request',
          resourceId: changeId,
          after: { title: fields.title, costChange: fields.costChange },
        },
        { prisma },
      );
    });
    return this.list(projectId, actor);
  }

  /** To the change board, as a request routed by its approval matrix. */
  async submit(
    projectId: string,
    changeId: string,
    actor: Principal,
    authorization: string,
    now = new Date(),
  ) {
    const { project } = await this.editable(projectId, actor);
    const current = await this.requireChange(projectId, changeId);
    if (current.status !== 'draft') {
      throw new AppError('CONFLICT', 'คำขอนี้ส่งไปแล้ว');
    }
    const base = await this.budgetInForce(projectId);
    const lines = readLines(current.costLines);
    const problems = submitProblems({
      title: current.title,
      reason: current.reason,
      scopeAdded: current.scopeAdded,
      scopeRemoved: current.scopeRemoved,
      scheduleDays: current.scheduleDays,
      lines: lines.length,
      priceChange: Number(current.priceChange),
      budgetLocked: base !== null,
    });
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'change', reason })),
      );
    }
    const config = (await this.configs.findFirst({
      where: { companyId: project.companyId },
      select: { projectChangeTypeCode: true },
    })) as { projectChangeTypeCode: string | null } | null;
    const typeCode = config?.projectChangeTypeCode;
    if (!typeCode) {
      throw new AppError(
        'CONFLICT',
        'ยังไม่ได้ตั้งประเภทคำขอเปลี่ยนแปลงโครงการในหน้าตั้งค่า CRM',
      );
    }
    const impact = changeImpact(
      {
        total: base?.total ?? null,
        contractValue: base?.contractValue ?? null,
      },
      Number(current.costChange),
      Number(current.priceChange),
    );
    const label = `CR-${current.seq}`;
    let requestId: string | null = null;
    let error: string | null = null;
    try {
      const created = (await this.requests.create(
        {
          type_code: typeCode,
          ref_type: 'project',
          ref_id: project.projectNo,
          // `cost_change`, `price_change`, `margin_pct` are what a matrix
          // level may route on; the rest is for the board to read
          form_data: {
            subject: `${project.projectNo} ${label}: ${current.title}`,
            project_no: project.projectNo,
            change_no: label,
            reason: current.reason,
            scope_added: current.scopeAdded ?? '',
            scope_removed: current.scopeRemoved ?? '',
            schedule_days: current.scheduleDays,
            cost_change: Number(current.costChange),
            price_change: Number(current.priceChange),
            ...(impact.margin.toPct !== null
              ? { margin_pct: impact.margin.toPct }
              : {}),
            detail:
              `${current.title} — ต้นทุน ${signed(Number(current.costChange))} บาท · ` +
              `ราคา ${signed(Number(current.priceChange))} บาท · เวลา ${signed(current.scheduleDays)} วันทำงาน` +
              (impact.margin.toPct !== null
                ? ` · margin ${impact.margin.fromPct}% → ${impact.margin.toPct}%`
                : ''),
          },
        },
        actor,
      )) as { id: string };
      requestId = created.id;
      await this.requests.submit(requestId, actor, authorization);
    } catch (failure) {
      error = requestId
        ? `สร้างร่างคำขอแล้วแต่ยื่นไม่ผ่าน: ${messageOf(failure)} — เปิดร่างคำขอเพื่อกรอกให้ครบแล้วยื่น`
        : `สร้างคำขอไม่ได้: ${messageOf(failure)}`;
    }
    if (!requestId) {
      await this.changes.update({ where: { id: changeId }, data: { error } });
      throw new AppError('CONFLICT', error ?? 'สร้างคำขอไม่ได้');
    }
    await this.transactions.execute(async (prisma) => {
      await this.changes.update(
        {
          where: { id: changeId },
          data: {
            status: 'submitted',
            requestId,
            error,
            submittedAt: now,
            submittedBy: actor.userId,
          },
        },
        { prisma },
      );
      await this.audit.record(
        {
          eventType: 'pm.change.submitted',
          companyId: project.companyId,
          ...auditActor(actor),
          resourceType: 'project_change_request',
          resourceId: changeId,
          after: {
            requestId,
            costChange: Number(current.costChange),
            priceChange: Number(current.priceChange),
            marginPct: impact.margin.toPct,
          },
        },
        { prisma },
      );
    });
    return this.list(projectId, actor);
  }

  /** Withdrawn before it went, or after the board turned it down. */
  async cancel(projectId: string, changeId: string, actor: Principal) {
    const { project } = await this.editable(projectId, actor);
    const current = await this.requireChange(projectId, changeId);
    if (current.status !== 'draft') {
      throw new AppError(
        'CONFLICT',
        'ยกเลิกได้เฉพาะร่าง — คำขอที่ส่งแล้วให้ยกเลิกที่ตัวคำขออนุมัติ',
      );
    }
    await this.transactions.execute(async (prisma) => {
      await this.changes.update(
        {
          where: { id: changeId },
          data: { status: 'cancelled', updatedBy: actor.userId },
        },
        { prisma },
      );
      await this.audit.record(
        {
          eventType: 'pm.change.cancelled',
          companyId: project.companyId,
          ...auditActor(actor),
          resourceType: 'project_change_request',
          resourceId: changeId,
        },
        { prisma },
      );
    });
    return this.list(projectId, actor);
  }

  /** May work tied to this change start? Only once the board approved it. */
  async workMayStart(changeRequestId: string | null): Promise<string | null> {
    if (!changeRequestId) return null;
    const row = (await this.changes.findFirst({
      where: { id: changeRequestId },
      select: { seq: true, status: true, requestId: true },
    })) as { seq: number; status: string; requestId: string | null } | null;
    if (!row) return null;
    if (row.status === 'submitted' && row.requestId) {
      await this.syncRequest(row.requestId);
      return this.workMayStart(changeRequestId);
    }
    return row.status === 'approved'
      ? null
      : `งานนี้มาจาก CR-${row.seq} ที่ยังไม่ได้รับอนุมัติ — เริ่มงานก่อนอนุมัติไม่ได้`;
  }

  /**
   * The board's decision, read off its request: approved writes the next
   * budget version (when the change has cost lines and a budget is in
   * force); rejected or cancelled closes the change. Once only.
   */
  async syncRequest(requestId: string, now = new Date()) {
    const row = (await this.changes.findFirst({
      where: { requestId, status: 'submitted' },
    })) as ChangeRow | null;
    if (!row) return;
    const request = (await this.requestRows.findFirst({
      where: { id: requestId },
      select: { status: true },
    })) as { status: string } | null;
    const state = approvalStateOf(true, request);
    if (state !== 'approved' && state !== 'rejected') return;

    const decided = await this.transactions.execute(async (prisma) => {
      const claimed = await prisma.projectChangeRequest.updateMany({
        where: { id: row.id, status: 'submitted' },
        data: { status: state, decidedAt: now },
      });
      if (!claimed.count) return false;
      if (state === 'approved') {
        const lines = readLines(row.costLines);
        const base = (await prisma.projectBudget.findFirst({
          where: { projectId: row.projectId, status: 'locked' },
          orderBy: { versionNo: 'desc' },
        })) as {
          id: string;
          versionNo: number;
          lines: unknown;
          contractValue: Prisma.Decimal | null;
        } | null;
        if (base && (lines.length || Number(row.priceChange))) {
          const last = (await prisma.projectBudget.findFirst({
            where: { projectId: row.projectId },
            orderBy: { versionNo: 'desc' },
            select: { versionNo: true },
          })) as { versionNo: number };
          const nextLines = budgetAfter(
            readLines(base.lines),
            lines,
            `CR-${row.seq}`,
          );
          const contractValue =
            base.contractValue === null
              ? null
              : Number(base.contractValue) + Number(row.priceChange);
          const next = await prisma.projectBudget.create({
            data: {
              companyId: row.companyId,
              projectId: row.projectId,
              versionNo: last.versionNo + 1,
              status: 'locked',
              lines: nextLines as unknown as Prisma.InputJsonValue,
              total: budgetTotals(nextLines, contractValue).total,
              contractValue,
              changeRequestId: row.id,
              note: `CR-${row.seq}: ${row.title}`,
              createdBy: row.submittedBy ?? row.createdBy,
              lockedAt: now,
              lockedBy: row.submittedBy ?? row.createdBy,
            },
            select: { id: true },
          });
          await prisma.projectBudget.update({
            where: { id: base.id },
            data: { status: 'superseded' },
          });
          await prisma.projectChangeRequest.update({
            where: { id: row.id },
            data: { budgetId: next.id },
          });
        }
      }
      await this.audit.record(
        {
          eventType: `pm.change.${state}`,
          companyId: row.companyId,
          actorId: null,
          actorUsername: 'system',
          resourceType: 'project_change_request',
          resourceId: row.id,
          after: { requestId, state },
        },
        { prisma: prisma as never },
      );
      return true;
    });
    if (decided) {
      const project = (await this.projects.summary(row.projectId)) ?? null;
      if (project) {
        await this.notifications
          .changeDecided(
            row.submittedBy ?? row.createdBy,
            row.companyId,
            project,
            {
              seq: row.seq,
              title: row.title,
              approved: state === 'approved',
            },
          )
          .catch(() => undefined);
      }
    }
  }

  // --- helpers -------------------------------------------------------------------

  private fieldsOf(dto: SaveChangeRequestDto, current: ChangeRow | null) {
    const lineInput =
      dto.cost_lines ??
      (current
        ? readLines(current.costLines).map((line) => ({
            category: line.category,
            code: line.code,
            description: line.description,
            quantity: line.quantity,
            unit: line.unit,
            unit_cost: line.unitCost,
          }))
        : []);
    const { lines, problems } = cleanChangeLines(lineInput);
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'cost_lines', reason })),
      );
    }
    const title = (dto.title ?? current?.title ?? '').trim();
    if (!title) {
      throw new AppError('VALIDATION_FAILED', 'ต้องระบุเรื่อง', [
        { field: 'title', reason: 'required' },
      ]);
    }
    return {
      title,
      reason: (dto.reason ?? current?.reason ?? '').trim(),
      scopeAdded:
        dto.scope_added !== undefined
          ? dto.scope_added.trim() || null
          : (current?.scopeAdded ?? null),
      scopeRemoved:
        dto.scope_removed !== undefined
          ? dto.scope_removed.trim() || null
          : (current?.scopeRemoved ?? null),
      scheduleDays: dto.schedule_days ?? current?.scheduleDays ?? 0,
      costLines: lines as unknown as Prisma.InputJsonValue,
      costChange: costChangeOf(lines),
      priceChange: dto.price_change ?? Number(current?.priceChange ?? 0),
    };
  }

  private present(
    row: ChangeRow,
    base: { total: number; contractValue: number | null } | null,
    names: Map<string, string>,
    requestNo: string | null | undefined,
  ) {
    const lines = readLines(row.costLines);
    return {
      id: row.id,
      seq: row.seq,
      label: `CR-${row.seq}`,
      title: row.title,
      reason: row.reason,
      scopeAdded: row.scopeAdded,
      scopeRemoved: row.scopeRemoved,
      scheduleDays: row.scheduleDays,
      costLines: lines,
      costChange: Number(row.costChange),
      priceChange: Number(row.priceChange),
      status: row.status,
      // against the budget in force now (an applied change is already in it)
      impact:
        row.status === 'approved'
          ? null
          : changeImpact(
              {
                total: base?.total ?? null,
                contractValue: base?.contractValue ?? null,
              },
              Number(row.costChange),
              Number(row.priceChange),
            ),
      request: row.requestId
        ? { id: row.requestId, requestNo: requestNo ?? null }
        : null,
      error: row.error,
      submittedAt: row.submittedAt,
      submittedByName: row.submittedBy
        ? (names.get(row.submittedBy) ?? null)
        : null,
      decidedAt: row.decidedAt,
      budgetId: row.budgetId,
      createdAt: row.createdAt,
      createdByName: names.get(row.createdBy) ?? null,
    };
  }

  private async budgetInForce(projectId: string) {
    const row = (await this.budgets.findFirst({
      where: { projectId, status: 'locked' },
      orderBy: { versionNo: 'desc' },
      select: { versionNo: true, total: true, contractValue: true },
    })) as {
      versionNo: number;
      total: Prisma.Decimal;
      contractValue: Prisma.Decimal | null;
    } | null;
    return row
      ? {
          versionNo: row.versionNo,
          total: Number(row.total),
          contractValue:
            row.contractValue === null ? null : Number(row.contractValue),
        }
      : null;
  }

  private async rows(projectId: string) {
    return (await this.changes.findMany({
      where: { projectId },
      orderBy: { seq: 'desc' },
    })) as ChangeRow[];
  }

  private async requireChange(projectId: string, changeId: string) {
    const row = (await this.changes.findFirst({
      where: { id: changeId, projectId },
    })) as ChangeRow | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบคำขอเปลี่ยนแปลง');
    return row;
  }

  private async editable(projectId: string, actor: Principal) {
    const access = await this.projects.access(projectId, actor);
    if (!access.canEdit) {
      throw new AppError(
        'FORBIDDEN',
        'ขอเปลี่ยนแปลงได้เฉพาะผู้จัดการโครงการ หรือผู้มีสิทธิ์จัดการโครงการ ขณะโครงการยังดำเนินอยู่',
      );
    }
    return access;
  }

  private async requestNos(ids: (string | null)[]) {
    const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    if (!unique.length) return new Map<string, string | null>();
    const rows = (await this.requestRows.findMany({
      where: { id: { in: unique } },
      select: { id: true, requestNo: true },
    })) as { id: string; requestNo: string | null }[];
    return new Map(rows.map((row) => [row.id, row.requestNo]));
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

const signed = (value: number) =>
  `${value > 0 ? '+' : ''}${value.toLocaleString('th-TH', { maximumFractionDigits: 2 })}`;
