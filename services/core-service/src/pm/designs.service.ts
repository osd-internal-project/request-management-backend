import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
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
import { approvalStateOf } from '../crm/contract-terms';
import { CrmConfigRepository } from '../crm/segment.repositories';
import { DomainEventsService } from '../events/domain-events.service';
import { DOMAIN_EVENTS } from '../events/event-catalog';
import { NotificationsService } from '../notifications/notifications.service';
import { safeFileName } from '../requests/attachments.service';
import { RequestRepository } from '../requests/request.repository';
import { RequestsService } from '../requests/requests.service';
import {
  cleanSettings,
  designInForce,
  designSubmitProblems,
  MAX_DESIGN_FILES,
  MAX_DESIGN_TEXT,
  openVersion,
  readSettings,
} from './design-rules';
import { SaveDesignDto } from './dto/project.dto';
import { EVIDENCE_TYPES, MAX_EVIDENCE_BYTES } from './milestones.service';
import {
  ProjectDesignFileRepository,
  ProjectDesignRepository,
  ProjectRepository,
} from './project.repositories';
import { ProjectsService } from './projects.service';

interface DesignRow {
  id: string;
  companyId: string;
  projectId: string;
  versionNo: number;
  title: string;
  summary: string | null;
  configuration: unknown;
  solutionVersionId: string | null;
  differsFromSolution: boolean;
  differences: string | null;
  status: string;
  requestId: string | null;
  error: string | null;
  submittedAt: Date | null;
  submittedBy: string | null;
  decidedAt: Date | null;
  createdBy: string;
  files: {
    id: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    storageKey: string;
    uploadedBy: string;
    uploadedAt: Date;
  }[];
}

interface UploadedFile {
  readonly originalname: string;
  readonly mimetype: string;
  readonly size: number;
  readonly buffer: Buffer;
}

type Access = Awaited<ReturnType<ProjectsService['access']>>;

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * CD-211 ออกแบบรายละเอียด — the project's detailed design, version by
 * version: drawings, the key configuration values, and how it differs from
 * the approved Solution version of the baseline. A draft goes to the
 * approvers as a request of the type in CRM settings
 * (`projectDesignTypeCode`, routed on `differs_from_solution`); the newest
 * approved version is in force, and any change is a new version approved
 * again — an approved version never changes. The as-built (CD-226) may
 * point at the design in force.
 *
 * Who: whoever sees the project reads it; the team drafts; `pm.project.manage`
 * or the project's manager sends a draft for approval.
 */
@Injectable()
export class DesignsService implements OnModuleInit {
  private readonly logger = new Logger(DesignsService.name);

  constructor(
    private readonly projects: ProjectsService,
    private readonly projectRows: ProjectRepository,
    private readonly designs: ProjectDesignRepository,
    private readonly files: ProjectDesignFileRepository,
    private readonly configs: CrmConfigRepository,
    private readonly requestRows: RequestRepository,
    private readonly requests: RequestsService,
    private readonly people: CompanyMemberRepository,
    private readonly notifications: NotificationsService,
    private readonly events: DomainEventsService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
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
          this.logger.warn(`design not synced: ${error.message}`),
        );
      });
    }
  }

  async view(projectId: string, actor: Principal) {
    const access = await this.projects.access(projectId, actor);
    let rows = await this.rows(projectId);
    // a decision the event did not carry is read here
    for (const row of rows.filter((item) => item.status === 'submitted')) {
      if (row.requestId) await this.syncRequest(row.requestId);
    }
    rows = await this.rows(projectId);
    const config = await this.typeCode(access.project.companyId);
    const requestNos = await this.requestNos(rows.map((row) => row.requestId));
    const names = await this.displayNames([
      ...rows.map((row) => row.submittedBy),
      ...rows.flatMap((row) => row.files.map((file) => file.uploadedBy)),
    ]);
    const inForce = designInForce(rows);
    const open = openVersion(rows);
    return {
      canEdit: access.canEdit,
      canWrite: this.mayWrite(access, actor),
      typeConfigured: Boolean(config),
      inForce: inForce
        ? { id: inForce.id, label: `v${inForce.versionNo}` }
        : null,
      openId: open?.id ?? null,
      versions: rows.map((row) => ({
        id: row.id,
        label: `v${row.versionNo}`,
        versionNo: row.versionNo,
        title: row.title,
        summary: row.summary,
        configuration: readSettings(row.configuration),
        differsFromSolution: row.differsFromSolution,
        differences: row.differences,
        status: row.status,
        inForce: row.id === inForce?.id,
        request: row.requestId
          ? {
              id: row.requestId,
              requestNo: requestNos.get(row.requestId) ?? null,
            }
          : null,
        error: row.error,
        submittedAt: row.submittedAt,
        submittedByName: row.submittedBy
          ? (names.get(row.submittedBy) ?? null)
          : null,
        decidedAt: row.decidedAt,
        files: row.files.map((file) => ({
          id: file.id,
          fileName: file.fileName,
          sizeBytes: file.sizeBytes,
          uploadedAt: file.uploadedAt,
          uploadedByName: names.get(file.uploadedBy) ?? null,
        })),
      })),
    };
  }

  /** The design in force, for the as-built's references (CD-226). */
  async inForce(projectId: string) {
    const rows = (await this.designs.findMany({
      where: { projectId, status: 'approved' },
      select: { versionNo: true, status: true, title: true },
    })) as { versionNo: number; status: string; title: string }[];
    return designInForce(rows);
  }

  /** A new version: a copy of the one in force (files and all), or blank. */
  async create(projectId: string, actor: Principal) {
    const access = await this.writer(projectId, actor);
    const rows = await this.rows(projectId);
    const open = openVersion(rows);
    if (open) {
      throw new AppError(
        'CONFLICT',
        `มีแบบ v${open.versionNo} ที่ยังแก้หรือรออนุมัติอยู่`,
      );
    }
    const base = designInForce(rows);
    const project = (await this.projectRows.findFirst({
      where: { id: projectId },
      select: { solutionVersionId: true },
    })) as { solutionVersionId: string | null } | null;
    const versionNo =
      rows.reduce((max, row) => Math.max(max, row.versionNo), 0) + 1;
    await this.transactions.execute(async (prisma) => {
      const created = await prisma.projectDesign.create({
        data: {
          companyId: access.project.companyId,
          projectId,
          versionNo,
          title: base?.title ?? 'แบบรายละเอียด',
          summary: base?.summary ?? null,
          configuration: base?.configuration ?? [],
          solutionVersionId: project?.solutionVersionId ?? null,
          differsFromSolution: base?.differsFromSolution ?? false,
          differences: base?.differences ?? null,
          createdBy: actor.userId,
        },
        select: { id: true },
      });
      if (base?.files.length) {
        await prisma.projectDesignFile.createMany({
          data: base.files.map((file) => ({
            companyId: access.project.companyId,
            designId: created.id,
            fileName: file.fileName,
            mimeType: file.mimeType,
            sizeBytes: file.sizeBytes,
            storageKey: file.storageKey,
            uploadedBy: file.uploadedBy,
            uploadedAt: file.uploadedAt,
          })),
        });
      }
      await this.audit.record(
        {
          eventType: 'pm.design.drafted',
          companyId: access.project.companyId,
          ...auditActor(actor),
          resourceType: 'project',
          resourceId: projectId,
          after: {
            designId: created.id,
            versionNo,
            from: base ? `v${base.versionNo}` : null,
          },
        },
        { prisma },
      );
    });
    return this.view(projectId, actor);
  }

  async update(
    projectId: string,
    designId: string,
    dto: SaveDesignDto,
    actor: Principal,
  ) {
    const access = await this.writer(projectId, actor);
    const current = await this.requireDraft(projectId, designId);
    const { settings, problems } =
      dto.configuration === undefined
        ? { settings: undefined, problems: [] as string[] }
        : cleanSettings(dto.configuration);
    const title = dto.title === undefined ? undefined : dto.title.trim();
    if (title !== undefined && (!title || title.length > 255)) {
      problems.push('ต้องระบุชื่อแบบ (ไม่เกิน 255 ตัวอักษร)');
    }
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'design', reason })),
      );
    }
    const data = {
      title,
      summary:
        dto.summary === undefined
          ? undefined
          : dto.summary.trim().slice(0, MAX_DESIGN_TEXT) || null,
      configuration: settings as Prisma.InputJsonValue | undefined,
      differsFromSolution: dto.differs_from_solution,
      differences:
        dto.differences === undefined
          ? undefined
          : dto.differences.trim().slice(0, MAX_DESIGN_TEXT) || null,
      updatedBy: actor.userId,
    };
    await this.transactions.execute(async (prisma) => {
      await this.designs.update({ where: { id: designId }, data }, { prisma });
      await this.audit.record(
        {
          eventType: 'pm.design.updated',
          companyId: access.project.companyId,
          ...auditActor(actor),
          resourceType: 'project',
          resourceId: projectId,
          before: { designId, title: current.title },
          after: { designId, ...dto } as unknown as Prisma.InputJsonValue,
        },
        { prisma },
      );
    });
    return this.view(projectId, actor);
  }

  async attach(
    projectId: string,
    designId: string,
    file: UploadedFile | undefined,
    actor: Principal,
    now = new Date(),
  ) {
    const access = await this.writer(projectId, actor);
    const current = await this.requireDraft(projectId, designId);
    const problems: string[] = [];
    if (!file) problems.push('ต้องแนบไฟล์');
    if (
      file &&
      !(EVIDENCE_TYPES as readonly string[]).includes(file.mimetype)
    ) {
      problems.push('แนบได้เฉพาะ PDF รูปภาพ Word หรือ Excel');
    }
    if (file && file.size > MAX_EVIDENCE_BYTES)
      problems.push('ไฟล์ใหญ่เกิน 25 MB');
    if (current.files.length >= MAX_DESIGN_FILES) {
      problems.push(`แนบไฟล์ได้ไม่เกิน ${MAX_DESIGN_FILES} ไฟล์`);
    }
    if (problems.length || !file) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'file', reason })),
      );
    }
    const name = safeFileName(file.originalname);
    const key = `projects/${projectId}/designs/${designId}/${randomUUID()}/${name}`;
    await this.storage.put(key, file.buffer, {
      contentType: file.mimetype,
      size: file.size,
    });
    try {
      await this.transactions.execute(async (prisma) => {
        await this.files.create(
          {
            data: {
              companyId: access.project.companyId,
              designId,
              fileName: name,
              mimeType: file.mimetype,
              sizeBytes: file.size,
              storageKey: key,
              uploadedBy: actor.userId,
              uploadedAt: now,
            },
          },
          { prisma },
        );
        await this.audit.record(
          {
            eventType: 'pm.design.file_attached',
            companyId: access.project.companyId,
            ...auditActor(actor),
            resourceType: 'project',
            resourceId: projectId,
            after: { designId, fileName: name },
          },
          { prisma },
        );
      });
    } catch (error) {
      await this.storage.remove(key).catch(() => undefined);
      throw error;
    }
    return this.view(projectId, actor);
  }

  /** Off the draft; the object stays (an approved version may share it). */
  async detach(
    projectId: string,
    designId: string,
    fileId: string,
    actor: Principal,
  ) {
    const access = await this.writer(projectId, actor);
    const current = await this.requireDraft(projectId, designId);
    if (!current.files.some((file) => file.id === fileId)) {
      throw new AppError('NOT_FOUND', 'ไม่พบไฟล์');
    }
    await this.transactions.execute(async (prisma) => {
      await this.files.update(
        { where: { id: fileId }, data: { deletedAt: new Date() } },
        { prisma },
      );
      await this.audit.record(
        {
          eventType: 'pm.design.file_removed',
          companyId: access.project.companyId,
          ...auditActor(actor),
          resourceType: 'project',
          resourceId: projectId,
          before: { designId, fileId },
        },
        { prisma },
      );
    });
    return this.view(projectId, actor);
  }

  async download(
    projectId: string,
    fileId: string,
    actor: Principal,
  ): Promise<{ stream: Readable; fileName: string; mimeType: string }> {
    await this.projects.access(projectId, actor);
    const row = (await this.files.findFirst({
      where: { id: fileId, deletedAt: null, design: { projectId } },
      select: { storageKey: true, fileName: true, mimeType: true },
    })) as { storageKey: string; fileName: string; mimeType: string } | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบไฟล์');
    return {
      stream: await this.storage.get(row.storageKey),
      fileName: row.fileName,
      mimeType: row.mimeType,
    };
  }

  /** The draft to the approvers, as a request of the configured type. */
  async submit(
    projectId: string,
    designId: string,
    actor: Principal,
    authorization: string,
    now = new Date(),
  ) {
    const access = await this.projects.access(projectId, actor);
    if (!access.canEdit) {
      throw new AppError(
        'FORBIDDEN',
        'ส่งแบบขออนุมัติได้เฉพาะผู้จัดการโครงการ หรือผู้มีสิทธิ์จัดการโครงการ',
      );
    }
    const current = await this.requireDraft(projectId, designId);
    const problems = designSubmitProblems({
      title: current.title,
      files: current.files.length,
      differsFromSolution: current.differsFromSolution,
      differences: current.differences,
    });
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'design', reason })),
      );
    }
    const typeCode = await this.typeCode(access.project.companyId);
    if (!typeCode) {
      throw new AppError(
        'CONFLICT',
        'ยังไม่ได้ตั้งประเภทคำขออนุมัติแบบรายละเอียดในหน้าตั้งค่า CRM',
      );
    }
    const project = access.project;
    const label = `v${current.versionNo}`;
    let requestId: string | null = null;
    let error: string | null = null;
    try {
      const created = (await this.requests.create(
        {
          type_code: typeCode,
          ref_type: 'project',
          ref_id: project.projectNo,
          form_data: {
            subject: `${project.projectNo} แบบรายละเอียด ${label}: ${current.title}`,
            project_no: project.projectNo,
            design_no: label,
            differs_from_solution: current.differsFromSolution ? 1 : 0,
            differences: current.differences ?? '',
            files: current.files.length,
            detail:
              `${current.title} — ${current.files.length} ไฟล์ · ค่าตั้งค่า ${readSettings(current.configuration).length} รายการ` +
              (current.differsFromSolution
                ? ` · ต่างจาก Solution: ${current.differences ?? ''}`
                : ' · ตรงตาม Solution ที่อนุมัติ'),
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
      await this.designs.update({ where: { id: designId }, data: { error } });
      throw new AppError('CONFLICT', error ?? 'สร้างคำขอไม่ได้');
    }
    await this.transactions.execute(async (prisma) => {
      await prisma.projectDesign.update({
        where: { id: designId },
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
          eventType: 'pm.design.submitted',
          companyId: project.companyId,
          ...auditActor(actor),
          resourceType: 'project',
          resourceId: projectId,
          after: { designId, label, requestId },
        },
        { prisma },
      );
    });
    return this.view(projectId, actor);
  }

  /**
   * The approvers' decision: approved puts the version in force (the one
   * before is superseded); rejected leaves room for a new version. Once only.
   */
  async syncRequest(requestId: string, now = new Date()) {
    const row = (await this.designs.findFirst({
      where: { requestId, status: 'submitted' },
    })) as Omit<DesignRow, 'files'> | null;
    if (!row) return;
    const request = (await this.requestRows.findFirst({
      where: { id: requestId },
      select: { status: true },
    })) as { status: string } | null;
    const state = approvalStateOf(true, request);
    if (state !== 'approved' && state !== 'rejected') return;
    const decided = await this.transactions.execute(async (prisma) => {
      const claimed = await prisma.projectDesign.updateMany({
        where: { id: row.id, status: 'submitted' },
        data: { status: state, decidedAt: now },
      });
      if (!claimed.count) return false;
      if (state === 'approved') {
        await prisma.projectDesign.updateMany({
          where: {
            projectId: row.projectId,
            status: 'approved',
            id: { not: row.id },
          },
          data: { status: 'superseded' },
        });
      }
      await this.audit.record(
        {
          eventType: `pm.design.${state}`,
          companyId: row.companyId,
          actorId: null,
          actorUsername: 'system',
          resourceType: 'project',
          resourceId: row.projectId,
          after: { designId: row.id, versionNo: row.versionNo, state },
        },
        { prisma: prisma as never },
      );
      return true;
    });
    if (decided && row.submittedBy) {
      const project = await this.projects.summary(row.projectId);
      if (project) {
        await this.notifications
          .designDecided(
            row.submittedBy,
            row.companyId,
            project,
            `v${row.versionNo}`,
            state === 'approved',
          )
          .catch(() => undefined);
      }
    }
  }

  // --- helpers -----------------------------------------------------------------------

  private async rows(projectId: string) {
    return (await this.designs.findMany({
      where: { projectId },
      orderBy: { versionNo: 'desc' },
      include: {
        files: { where: { deletedAt: null }, orderBy: { uploadedAt: 'asc' } },
      },
    })) as unknown as DesignRow[];
  }

  private async requireDraft(projectId: string, designId: string) {
    const row = (await this.designs.findFirst({
      where: { id: designId, projectId },
      include: { files: { where: { deletedAt: null } } },
    })) as unknown as DesignRow | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบแบบ');
    if (row.status !== 'draft') {
      throw new AppError(
        'CONFLICT',
        'แก้ได้เฉพาะแบบที่เป็นร่าง — แบบที่ส่งหรืออนุมัติแล้วต้องทำเวอร์ชันใหม่',
      );
    }
    return row;
  }

  private async typeCode(companyId: string) {
    const row = (await this.configs.findFirst({
      where: { companyId },
      select: { projectDesignTypeCode: true },
    })) as { projectDesignTypeCode: string | null } | null;
    return row?.projectDesignTypeCode ?? null;
  }

  private async writer(projectId: string, actor: Principal) {
    const access = await this.projects.access(projectId, actor);
    if (!this.mayWrite(access, actor)) {
      throw new AppError(
        'FORBIDDEN',
        'ทำแบบรายละเอียดได้เฉพาะทีมโครงการ ขณะโครงการยังดำเนินอยู่',
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
