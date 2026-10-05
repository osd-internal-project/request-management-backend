import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
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
import { RequestRepository } from '../requests/request.repository';
import { RequestsService } from '../requests/requests.service';
import { ChangeRequestsService } from './change-requests.service';
import { SaveTechChangeDto } from './dto/project.dto';
import {
  ProjectChangeRequestRepository,
  ProjectRepository,
  ProjectTechChangeRepository,
} from './project.repositories';
import { ProjectsService } from './projects.service';
import { asBuiltRefs } from './as-built-rules';
import {
  changeFromTech,
  costChangeOf,
  deviationsOf,
  inForce,
  MAX_TECH_TEXT,
  readTechLines,
  techLinesFrom,
  techSubmitProblems,
} from './tech-change-rules';

interface TechRow {
  id: string;
  companyId: string;
  projectId: string;
  seq: number;
  title: string;
  reason: string | null;
  description: string | null;
  boqLines: unknown;
  costChange: unknown;
  affectsScope: boolean;
  scopeAdded: string | null;
  scopeRemoved: string | null;
  changeRequestId: string | null;
  status: string;
  requestId: string | null;
  error: string | null;
  submittedAt: Date | null;
  submittedBy: string | null;
  decidedAt: Date | null;
  appliedAt: Date | null;
  createdBy: string;
}

type Access = Awaited<ReturnType<ProjectsService['access']>>;

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * CD-224 ปรับแก้ทางเทคนิค — a technical change the engineers ask approval
 * for, with what it does to the BOQ (lines from the baseline, or new ones),
 * the cost, and the scope. It is approved through the request engine
 * (CrmConfig.projectTechChangeTypeCode, Engineer → Pre-Sales · PM). One that
 * changes the scope needs a change request (CD-185) — the manager opens it
 * from the change — and is in force only once both are approved. In force,
 * its BOQ lines go into the as-built as deviations (CD-226), once.
 *
 * Who: whoever sees the project reads it; the team drafts while the project
 * runs; the manager opens the change request and submits.
 */
@Injectable()
export class TechChangesService implements OnModuleInit {
  private readonly logger = new Logger(TechChangesService.name);

  constructor(
    private readonly projects: ProjectsService,
    private readonly projectRows: ProjectRepository,
    private readonly techChanges: ProjectTechChangeRepository,
    private readonly changeRows: ProjectChangeRequestRepository,
    private readonly changes: ChangeRequestsService,
    private readonly configs: CrmConfigRepository,
    private readonly requestRows: RequestRepository,
    private readonly requests: RequestsService,
    private readonly people: CompanyMemberRepository,
    private readonly events: DomainEventsService,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  onModuleInit(): void {
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
          this.logger.warn(`technical change not synced: ${error.message}`),
        );
      });
    }
  }

  async view(projectId: string, actor: Principal) {
    const access = await this.projects.access(projectId, actor);
    // a change request decided since: whatever is now in force goes in
    await this.applyDue(projectId);
    const [rows, project] = await Promise.all([
      this.rows(projectId),
      this.projectRows.findFirst({
        where: { id: projectId },
        select: { baseline: true },
      }) as Promise<{ baseline: unknown } | null>,
    ]);
    const changes = await this.changeStates(rows);
    const names = await this.displayNames(
      rows.flatMap((row) => [row.createdBy, row.submittedBy]),
    );
    const requestNos = await this.requestNos(rows.map((row) => row.requestId));
    return {
      canWrite: this.mayWrite(access, actor),
      canEdit: access.canEdit,
      typeSet: Boolean(await this.typeCode(access.project.companyId)),
      boq: asBuiltRefs(project?.baseline ?? null).filter((row) =>
        row.ref.startsWith('boq:'),
      ),
      changes: rows.map((row) => {
        const change = row.changeRequestId
          ? changes.get(row.changeRequestId)
          : undefined;
        return {
          id: row.id,
          label: `TC-${row.seq}`,
          title: row.title,
          reason: row.reason,
          description: row.description,
          lines: readTechLines(row.boqLines),
          costChange: Number(row.costChange),
          affectsScope: row.affectsScope,
          scopeAdded: row.scopeAdded,
          scopeRemoved: row.scopeRemoved,
          change: change
            ? {
                id: row.changeRequestId,
                label: `CR-${change.seq}`,
                status: change.status,
              }
            : null,
          status: row.status,
          inForce: inForce({
            status: row.status,
            affectsScope: row.affectsScope,
            changeStatus: change?.status ?? null,
          }),
          applied: Boolean(row.appliedAt),
          requestNo: row.requestId
            ? (requestNos.get(row.requestId) ?? null)
            : null,
          error: row.error,
          submittedAt: row.submittedAt,
          submittedByName: row.submittedBy
            ? (names.get(row.submittedBy) ?? null)
            : null,
          decidedAt: row.decidedAt,
          createdByName: names.get(row.createdBy) ?? null,
          mayEdit:
            row.status === 'draft' &&
            (access.canEdit || row.createdBy === actor.userId),
        };
      }),
    };
  }

  async create(projectId: string, dto: SaveTechChangeDto, actor: Principal) {
    const access = await this.writer(projectId, actor);
    const input = await this.input(projectId, dto, null);
    await this.transactions.execute(async (prisma) => {
      const last = await prisma.projectTechChange.findFirst({
        where: { projectId },
        orderBy: { seq: 'desc' },
        select: { seq: true },
      });
      const row = await prisma.projectTechChange.create({
        data: {
          companyId: access.project.companyId,
          projectId,
          seq: (last?.seq ?? 0) + 1,
          ...input,
          createdBy: actor.userId,
        },
        select: { id: true, seq: true },
      });
      await this.audit.record(
        {
          eventType: 'pm.tech_change.created',
          companyId: access.project.companyId,
          ...auditActor(actor),
          resourceType: 'project',
          resourceId: projectId,
          after: {
            techChangeId: row.id,
            label: `TC-${row.seq}`,
            title: input.title,
            costChange: input.costChange,
          },
        },
        { prisma },
      );
    });
    return this.view(projectId, actor);
  }

  async update(
    projectId: string,
    techChangeId: string,
    dto: SaveTechChangeDto,
    actor: Principal,
  ) {
    const access = await this.writer(projectId, actor);
    const current = await this.requireDraft(projectId, techChangeId);
    if (!access.canEdit && current.createdBy !== actor.userId) {
      throw new AppError(
        'FORBIDDEN',
        'แก้ได้เฉพาะผู้บันทึก หรือผู้จัดการโครงการ',
      );
    }
    const input = await this.input(projectId, dto, current);
    await this.techChanges.update({
      where: { id: techChangeId },
      data: { ...input, updatedBy: actor.userId },
    });
    return this.view(projectId, actor);
  }

  /** A draft withdrawn (its writer or the manager). */
  async cancel(projectId: string, techChangeId: string, actor: Principal) {
    const access = await this.writer(projectId, actor);
    const current = await this.requireDraft(projectId, techChangeId);
    if (!access.canEdit && current.createdBy !== actor.userId) {
      throw new AppError(
        'FORBIDDEN',
        'ยกเลิกได้เฉพาะผู้บันทึก หรือผู้จัดการโครงการ',
      );
    }
    await this.transactions.execute(async (prisma) => {
      await prisma.projectTechChange.update({
        where: { id: techChangeId },
        data: { status: 'cancelled', updatedBy: actor.userId },
      });
      await this.audit.record(
        {
          eventType: 'pm.tech_change.cancelled',
          companyId: access.project.companyId,
          ...auditActor(actor),
          resourceType: 'project',
          resourceId: projectId,
          after: { techChangeId, label: `TC-${current.seq}` },
        },
        { prisma },
      );
    });
    return this.view(projectId, actor);
  }

  /** The manager opens the change request a scope change needs, as a draft. */
  async openChange(projectId: string, techChangeId: string, actor: Principal) {
    const access = await this.projects.access(projectId, actor);
    if (!access.canEdit) {
      throw new AppError(
        'FORBIDDEN',
        'เปิดคำขอเปลี่ยนแปลงได้เฉพาะผู้จัดการโครงการ',
      );
    }
    const current = await this.requireDraft(projectId, techChangeId);
    if (!current.affectsScope) {
      throw new AppError(
        'CONFLICT',
        'การปรับแก้นี้ไม่ได้กระทบขอบเขต — ไม่ต้องเปิดคำขอเปลี่ยนแปลง',
      );
    }
    if (current.changeRequestId) {
      throw new AppError('CONFLICT', 'เปิดคำขอเปลี่ยนแปลงไว้แล้ว');
    }
    if (!current.scopeAdded?.trim() && !current.scopeRemoved?.trim()) {
      throw new AppError(
        'VALIDATION_FAILED',
        'กระทบขอบเขต: ต้องระบุขอบเขตที่เพิ่มหรือลด',
      );
    }
    const created = await this.changes.create(
      projectId,
      changeFromTech({
        label: `TC-${current.seq}`,
        title: current.title,
        reason: current.reason,
        scopeAdded: current.scopeAdded,
        scopeRemoved: current.scopeRemoved,
        lines: readTechLines(current.boqLines),
      }),
      actor,
    );
    await this.techChanges.update({
      where: { id: techChangeId },
      data: { changeRequestId: created.changeId, updatedBy: actor.userId },
    });
    return {
      ...(await this.view(projectId, actor)),
      changeId: created.changeId,
    };
  }

  async submit(
    projectId: string,
    techChangeId: string,
    actor: Principal,
    authorization: string,
    now = new Date(),
  ) {
    const access = await this.projects.access(projectId, actor);
    if (!access.canEdit) {
      throw new AppError(
        'FORBIDDEN',
        'ยื่นขออนุมัติได้เฉพาะผู้จัดการโครงการ หรือผู้มีสิทธิ์จัดการโครงการ',
      );
    }
    const current = await this.requireDraft(projectId, techChangeId);
    const lines = readTechLines(current.boqLines);
    const problems = techSubmitProblems({
      title: current.title,
      reason: current.reason,
      description: current.description,
      lines: lines.length,
      affectsScope: current.affectsScope,
      scopeAdded: current.scopeAdded,
      scopeRemoved: current.scopeRemoved,
      changeRequestId: current.changeRequestId,
    });
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'tech_change', reason })),
      );
    }
    const typeCode = await this.typeCode(access.project.companyId);
    if (!typeCode) {
      throw new AppError(
        'CONFLICT',
        'ยังไม่ได้ตั้งประเภทคำขออนุมัติปรับแก้ทางเทคนิคในหน้าตั้งค่า CRM',
      );
    }
    const project = access.project;
    const label = `TC-${current.seq}`;
    const change = current.changeRequestId
      ? ((await this.changeRows.findFirst({
          where: { id: current.changeRequestId },
          select: { seq: true },
        })) as { seq: number } | null)
      : null;
    let requestId: string | null = null;
    let error: string | null = null;
    try {
      const created = (await this.requests.create(
        {
          type_code: typeCode,
          ref_type: 'project',
          ref_id: project.projectNo,
          form_data: {
            subject: `${project.projectNo} ปรับแก้ทางเทคนิค ${label}: ${current.title}`,
            project_no: project.projectNo,
            tech_change_no: label,
            affects_scope: current.affectsScope ? 1 : 0,
            cost_change: Number(current.costChange),
            change_request_no: change ? `CR-${change.seq}` : '',
            detail: [
              current.title,
              current.reason ? `เหตุผล: ${current.reason}` : '',
              current.description ?? '',
              ...lines.map(
                (line) =>
                  `${line.name}: ${line.quantityFrom} → ${line.quantityTo}${line.unit ? ` ${line.unit}` : ''}`,
              ),
              `ต้นทุนเปลี่ยน ${Number(current.costChange).toLocaleString('th-TH')} บาท`,
              current.affectsScope
                ? `กระทบขอบเขต — ${change ? `CR-${change.seq}` : ''}`
                : 'ไม่กระทบขอบเขต',
            ]
              .filter(Boolean)
              .join('\n'),
          },
        },
        actor,
      )) as { id: string };
      requestId = created.id;
      await this.requests.submit(requestId, actor, authorization);
    } catch (failure) {
      error = requestId
        ? `สร้างร่างคำขอแล้วแต่ยื่นไม่ผ่าน: ${messageOf(failure)}`
        : `สร้างคำขอไม่ได้: ${messageOf(failure)}`;
    }
    if (!requestId) {
      await this.techChanges.update({
        where: { id: techChangeId },
        data: { error },
      });
      throw new AppError('CONFLICT', error ?? 'สร้างคำขอไม่ได้');
    }
    await this.transactions.execute(async (prisma) => {
      await prisma.projectTechChange.update({
        where: { id: techChangeId },
        data: {
          status: 'submitted',
          requestId,
          error,
          submittedAt: now,
          submittedBy: actor.userId,
          updatedBy: actor.userId,
        },
      });
      await this.audit.record(
        {
          eventType: 'pm.tech_change.submitted',
          companyId: project.companyId,
          ...auditActor(actor),
          resourceType: 'project',
          resourceId: projectId,
          after: { techChangeId, label, requestId },
        },
        { prisma },
      );
    });
    return this.view(projectId, actor);
  }

  /**
   * A decision on a request: its own (approved or rejected, once), or its
   * change request's — either may put a change in force.
   */
  async syncRequest(requestId: string, now = new Date()) {
    const row = (await this.techChanges.findFirst({
      where: { requestId, status: 'submitted' },
    })) as TechRow | null;
    if (row) {
      const request = (await this.requestRows.findFirst({
        where: { id: requestId },
        select: { status: true },
      })) as { status: string } | null;
      const state = approvalStateOf(true, request);
      if (state === 'approved' || state === 'rejected') {
        const claimed = await this.techChanges.updateMany({
          where: { id: row.id, status: 'submitted' },
          data: { status: state, decidedAt: now },
        });
        if (claimed.count) {
          await this.audit.record({
            eventType: `pm.tech_change.${state}`,
            companyId: row.companyId,
            actorId: null,
            actorUsername: 'system',
            resourceType: 'project',
            resourceId: row.projectId,
            after: { techChangeId: row.id, label: `TC-${row.seq}`, state },
          });
        }
        await this.applyDue(row.projectId);
      }
      return;
    }
    // its change request decided: make sure that is recorded first
    const change = (await this.changeRows.findFirst({
      where: { requestId },
      select: { id: true, projectId: true },
    })) as { id: string; projectId: string } | null;
    if (!change) return;
    const linked = await this.techChanges.count({
      where: { changeRequestId: change.id },
    });
    if (!linked) return;
    await this.changes.syncRequest(requestId, now);
    await this.applyDue(change.projectId);
  }

  // --- helpers -----------------------------------------------------------------------

  /** Changes now in force, not yet in the as-built: their deviations, once. */
  private async applyDue(projectId: string) {
    const due = (await this.techChanges.findMany({
      where: { projectId, status: 'approved', appliedAt: null },
      orderBy: { seq: 'asc' },
    })) as TechRow[];
    if (!due.length) return;
    const changes = await this.changeStates(due);
    for (const row of due) {
      const change = row.changeRequestId
        ? changes.get(row.changeRequestId)
        : undefined;
      if (
        !inForce({
          status: row.status,
          affectsScope: row.affectsScope,
          changeStatus: change?.status ?? null,
        })
      ) {
        continue;
      }
      await this.transactions.execute(async (prisma) => {
        const claimed = await prisma.projectTechChange.updateMany({
          where: { id: row.id, appliedAt: null },
          data: { appliedAt: new Date() },
        });
        if (!claimed.count) return;
        const deviations = deviationsOf({
          label: `TC-${row.seq}`,
          title: row.title,
          reason: row.reason,
          affectsScope: row.affectsScope,
          changeRequestId: row.changeRequestId,
          lines: readTechLines(row.boqLines),
        });
        if (!deviations.length) return;
        const last = await prisma.projectAsBuiltDeviation.findFirst({
          where: { projectId },
          orderBy: { seq: 'desc' },
          select: { seq: true },
        });
        await prisma.projectAsBuiltDeviation.createMany({
          data: deviations.map((deviation, index) => ({
            companyId: row.companyId,
            projectId,
            seq: (last?.seq ?? 0) + index + 1,
            ...deviation,
            createdBy: row.submittedBy ?? row.createdBy,
          })),
        });
        await this.audit.record(
          {
            eventType: 'pm.tech_change.applied',
            companyId: row.companyId,
            actorId: null,
            actorUsername: 'system',
            resourceType: 'project',
            resourceId: projectId,
            after: {
              techChangeId: row.id,
              label: `TC-${row.seq}`,
              deviations: deviations.length,
            },
          },
          { prisma: prisma as never },
        );
      });
    }
  }

  private async input(
    projectId: string,
    dto: SaveTechChangeDto,
    current: TechRow | null,
  ) {
    const text = (given: string | undefined, was: string | null | undefined) =>
      given === undefined
        ? (was ?? null)
        : given.trim().slice(0, MAX_TECH_TEXT) || null;
    const title = (dto.title ?? current?.title ?? '').trim();
    const problems: string[] = [];
    if (!title) problems.push('ต้องตั้งชื่อการปรับแก้');
    if (title.length > 255) problems.push('ชื่อยาวเกิน 255 ตัวอักษร');
    let lines = current ? readTechLines(current.boqLines) : [];
    if (dto.lines !== undefined) {
      const project = (await this.projectRows.findFirst({
        where: { id: projectId },
        select: { baseline: true },
      })) as { baseline: unknown } | null;
      const read = techLinesFrom(dto.lines, project?.baseline ?? null);
      problems.push(...read.problems);
      lines = read.lines;
    }
    const affectsScope = dto.affects_scope ?? current?.affectsScope ?? false;
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'tech_change', reason })),
      );
    }
    return {
      title,
      reason: text(dto.reason, current?.reason),
      description: text(dto.description, current?.description),
      boqLines: lines as unknown as object[],
      costChange: costChangeOf(lines),
      affectsScope,
      scopeAdded: affectsScope
        ? text(dto.scope_added, current?.scopeAdded)
        : null,
      scopeRemoved: affectsScope
        ? text(dto.scope_removed, current?.scopeRemoved)
        : null,
    };
  }

  private async rows(projectId: string) {
    return (await this.techChanges.findMany({
      where: { projectId, status: { not: 'cancelled' } },
      orderBy: { seq: 'desc' },
    })) as TechRow[];
  }

  private async changeStates(rows: TechRow[]) {
    const ids = rows
      .map((row) => row.changeRequestId)
      .filter((id): id is string => Boolean(id));
    if (!ids.length) return new Map<string, { seq: number; status: string }>();
    const found = (await this.changeRows.findMany({
      where: { id: { in: ids } },
      select: { id: true, seq: true, status: true },
    })) as { id: string; seq: number; status: string }[];
    return new Map(
      found.map((row) => [row.id, { seq: row.seq, status: row.status }]),
    );
  }

  private async requireDraft(projectId: string, techChangeId: string) {
    const row = (await this.techChanges.findFirst({
      where: { id: techChangeId, projectId },
    })) as TechRow | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบการปรับแก้');
    if (row.status !== 'draft') {
      throw new AppError('CONFLICT', 'แก้ได้เฉพาะการปรับแก้ที่ยังเป็นร่าง');
    }
    return row;
  }

  private async typeCode(companyId: string) {
    const row = (await this.configs.findFirst({
      where: { companyId },
      select: { projectTechChangeTypeCode: true },
    })) as { projectTechChangeTypeCode: string | null } | null;
    return row?.projectTechChangeTypeCode ?? null;
  }

  private async writer(projectId: string, actor: Principal) {
    const access = await this.projects.access(projectId, actor);
    if (!this.mayWrite(access, actor)) {
      throw new AppError(
        'FORBIDDEN',
        'บันทึกการปรับแก้ได้เฉพาะทีมโครงการ ขณะโครงการยังดำเนินอยู่',
      );
    }
    return access;
  }

  private mayWrite(access: Access, actor: Principal) {
    const running =
      access.project.status === 'active' || access.project.status === 'on_hold';
    return (
      running &&
      (access.canEdit ||
        access.project.members.some((member) => member.userId === actor.userId))
    );
  }

  private async requestNos(ids: (string | null)[]) {
    const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    if (!unique.length) return new Map<string, string>();
    const rows = (await this.requestRows.findMany({
      where: { id: { in: unique } },
      select: { id: true, requestNo: true },
    })) as { id: string; requestNo: string | null }[];
    return new Map(rows.map((row) => [row.id, row.requestNo ?? row.id]));
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
