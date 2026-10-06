import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
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
import { ContractObligationRepository } from '../crm/contract-obligations.service';
import { approvalStateOf } from '../crm/contract-terms';
import { CrmConfigRepository } from '../crm/segment.repositories';
import { DomainEventsService } from '../events/domain-events.service';
import { DOMAIN_EVENTS } from '../events/event-catalog';
import { NotificationsService } from '../notifications/notifications.service';
import { safeFileName } from '../requests/attachments.service';
import { RequestRepository } from '../requests/request.repository';
import { RequestsService } from '../requests/requests.service';
import {
  closeChecks,
  closeoutEditable,
  closeProblems,
  lessonProblems,
  MAX_CLOSE_DOCUMENTS,
  missingDocuments,
} from './close-rules';
import { CustomerLogsService } from './customer-logs.service';
import { SaveCloseoutDto, SaveLessonDto } from './dto/project.dto';
import { EVIDENCE_TYPES, MAX_EVIDENCE_BYTES } from './milestones.service';
import { PaymentsService } from './payments.service';
import {
  ProjectChangeRequestRepository,
  ProjectCloseDocumentRepository,
  ProjectCloseoutRepository,
  ProjectIssueRepository,
  ProjectLessonRepository,
  ProjectMilestoneRepository,
  ProjectRepository,
  ProjectRiskRepository,
  ProjectTaskRepository,
} from './project.repositories';
import { ProjectsService } from './projects.service';

interface CloseoutRow {
  id: string;
  companyId: string;
  projectId: string;
  status: string;
  summary: string | null;
  requestId: string | null;
  error: string | null;
  submittedAt: Date | null;
  submittedBy: string | null;
  decidedAt: Date | null;
}

interface UploadedCloseFile {
  readonly originalname: string;
  readonly mimetype: string;
  readonly size: number;
  readonly buffer: Buffer;
}

type Access = Awaited<ReturnType<ProjectsService['access']>>;

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * CD-191 ปิดโครงการ — a project is closed through a checklist: nothing owed
 * (contract obligations CD-163, open issues CD-184, customer decisions not
 * yet a change CD-186, changes still pending CD-185, milestones not reached
 * CD-182), the documents it must leave behind (named in CRM settings), and
 * its lessons learned, kept here until KBMS (CD-22) takes them. Then the
 * manager asks the project's executives to close it, as a request of the
 * type set in CRM settings (`projectCloseTypeCode`); approved, the project
 * becomes `closed`.
 *
 * Who: whoever sees the project reads it; the team writes lessons;
 * `pm.project.manage` or the project's manager attaches the documents and
 * asks.
 */
@Injectable()
export class CloseoutService implements OnModuleInit {
  private readonly logger = new Logger(CloseoutService.name);

  constructor(
    private readonly projects: ProjectsService,
    private readonly projectRows: ProjectRepository,
    private readonly closeouts: ProjectCloseoutRepository,
    private readonly documents: ProjectCloseDocumentRepository,
    private readonly lessons: ProjectLessonRepository,
    private readonly milestones: ProjectMilestoneRepository,
    private readonly tasks: ProjectTaskRepository,
    private readonly issues: ProjectIssueRepository,
    private readonly changes: ProjectChangeRequestRepository,
    private readonly risks: ProjectRiskRepository,
    private readonly obligations: ContractObligationRepository,
    private readonly customerLogs: CustomerLogsService,
    private readonly payments: PaymentsService,
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
    // the executives' decision, when it lands
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
          this.logger.warn(`close-out not synced: ${error.message}`),
        );
      });
    }
  }

  async view(projectId: string, actor: Principal) {
    const access = await this.projects.access(projectId, actor);
    let closeout = await this.current(projectId);
    // a decision the event did not carry (missed, or made before) is read here
    if (closeout?.status === 'submitted' && closeout.requestId) {
      await this.syncRequest(closeout.requestId);
      closeout = await this.current(projectId);
    }
    const project = access.project;
    const config = await this.config(project.companyId);
    const [documents, lessons, checks] = await Promise.all([
      this.documents.findMany({
        where: { projectId, deletedAt: null },
        orderBy: { uploadedAt: 'asc' },
        select: {
          id: true,
          title: true,
          note: true,
          fileName: true,
          mimeType: true,
          sizeBytes: true,
          uploadedBy: true,
          uploadedAt: true,
        },
      }) as Promise<
        {
          id: string;
          title: string;
          note: string | null;
          fileName: string;
          mimeType: string;
          sizeBytes: number;
          uploadedBy: string;
          uploadedAt: Date;
        }[]
      >,
      this.lessons.findMany({
        where: { projectId, deletedAt: null },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          kind: true,
          text: true,
          kbmsStatus: true,
          // CD-263 — the knowledge article it went into
          kbmsRef: true,
          createdBy: true,
          createdAt: true,
        },
      }) as Promise<
        {
          id: string;
          kind: string;
          text: string;
          kbmsStatus: string;
          kbmsRef: string | null;
          createdBy: string;
          createdAt: Date;
        }[]
      >,
      this.checks(access, config.documents, actor),
    ]);
    const names = await this.displayNames([
      ...documents.map((row) => row.uploadedBy),
      ...lessons.map((row) => row.createdBy),
      closeout?.submittedBy ?? null,
    ]);
    const requestNo = closeout?.requestId
      ? ((await this.requestRows.findFirst({
          where: { id: closeout.requestId },
          select: { requestNo: true },
        })) as { requestNo: string | null } | null)
      : null;
    const editable = closeoutEditable(closeout?.status ?? null);
    return {
      canEdit: access.canEdit && editable,
      canWrite: this.mayWrite(access, actor) && editable,
      typeConfigured: Boolean(config.typeCode),
      projectStatus: project.status,
      closeout: closeout
        ? {
            status: closeout.status,
            summary: closeout.summary,
            error: closeout.error,
            requestId: closeout.requestId,
            requestNo: requestNo?.requestNo ?? null,
            submittedAt: closeout.submittedAt,
            submittedByName: closeout.submittedBy
              ? (names.get(closeout.submittedBy) ?? null)
              : null,
            decidedAt: closeout.decidedAt,
          }
        : null,
      checks,
      problems: closeProblems(checks),
      required: config.documents.map((title) => ({
        title,
        documentIds: documents
          .filter((row) => row.title.trim() === title.trim())
          .map((row) => row.id),
      })),
      documents: documents.map((row) => ({
        ...row,
        uploadedByName: names.get(row.uploadedBy) ?? null,
      })),
      lessons: lessons.map((row) => ({
        ...row,
        createdByName: names.get(row.createdBy) ?? null,
      })),
    };
  }

  /** The summary the executives read with the request. */
  async save(projectId: string, dto: SaveCloseoutDto, actor: Principal) {
    const access = await this.editable(projectId, actor);
    const summary = dto.summary?.trim() || null;
    await this.transactions.execute(async (prisma) => {
      await prisma.projectCloseout.upsert({
        where: { projectId },
        create: {
          companyId: access.project.companyId,
          projectId,
          summary,
          createdBy: actor.userId,
        },
        update: { summary, updatedBy: actor.userId },
      });
      await this.audit.record(
        {
          eventType: 'pm.closeout.saved',
          companyId: access.project.companyId,
          ...auditActor(actor),
          resourceType: 'project',
          resourceId: projectId,
          after: { summary },
        },
        { prisma },
      );
    });
    return this.view(projectId, actor);
  }

  // --- documents -----------------------------------------------------------------

  async attach(
    projectId: string,
    body: { title?: string; note?: string },
    file: UploadedCloseFile | undefined,
    actor: Principal,
    now = new Date(),
  ) {
    const access = await this.editable(projectId, actor);
    const title = (body.title ?? '').trim();
    const problems: string[] = [];
    if (!title) problems.push('ต้องระบุชื่อเอกสาร');
    if (title.length > 255) problems.push('ชื่อเอกสารยาวเกิน 255 ตัวอักษร');
    if (!file) problems.push('ต้องแนบไฟล์');
    if (
      file &&
      !(EVIDENCE_TYPES as readonly string[]).includes(file.mimetype)
    ) {
      problems.push('แนบได้เฉพาะรูป PDF Word หรือ Excel');
    }
    if (file && file.size > MAX_EVIDENCE_BYTES) {
      problems.push('ไฟล์ใหญ่เกิน 25 MB');
    }
    const count = await this.documents.count({
      where: { projectId, deletedAt: null },
    });
    if (count >= MAX_CLOSE_DOCUMENTS) {
      problems.push(`แนบเอกสารได้ไม่เกิน ${MAX_CLOSE_DOCUMENTS} ไฟล์`);
    }
    if (problems.length || !file) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'document', reason })),
      );
    }
    const id = randomUUID();
    const name = safeFileName(file.originalname);
    const key = `projects/${projectId}/closeout/${id}/${name}`;
    await this.storage.put(key, file.buffer, {
      contentType: file.mimetype,
      size: file.size,
    });
    try {
      await this.transactions.execute(async (prisma) => {
        await this.documents.create(
          {
            data: {
              id,
              companyId: access.project.companyId,
              projectId,
              title,
              note: body.note?.trim() || null,
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
            eventType: 'pm.closeout.document_attached',
            companyId: access.project.companyId,
            ...auditActor(actor),
            resourceType: 'project',
            resourceId: projectId,
            after: { documentId: id, title, fileName: name },
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

  /** Taken off the list; the file stays, as every record does. */
  async detach(projectId: string, documentId: string, actor: Principal) {
    const access = await this.editable(projectId, actor);
    const found = (await this.documents.findFirst({
      where: { id: documentId, projectId, deletedAt: null },
      select: { id: true, title: true },
    })) as { id: string; title: string } | null;
    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบเอกสาร');
    await this.transactions.execute(async (prisma) => {
      await this.documents.update(
        {
          where: { id: documentId },
          data: { deletedAt: new Date(), deletedBy: actor.userId },
        },
        { prisma },
      );
      await this.audit.record(
        {
          eventType: 'pm.closeout.document_removed',
          companyId: access.project.companyId,
          ...auditActor(actor),
          resourceType: 'project',
          resourceId: projectId,
          before: { documentId, title: found.title },
        },
        { prisma },
      );
    });
    return this.view(projectId, actor);
  }

  async download(
    projectId: string,
    documentId: string,
    actor: Principal,
  ): Promise<{ stream: Readable; fileName: string; mimeType: string }> {
    await this.projects.access(projectId, actor);
    const row = (await this.documents.findFirst({
      where: { id: documentId, projectId, deletedAt: null },
      select: { storageKey: true, fileName: true, mimeType: true },
    })) as { storageKey: string; fileName: string; mimeType: string } | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบเอกสาร');
    return {
      stream: await this.storage.get(row.storageKey),
      fileName: row.fileName,
      mimeType: row.mimeType,
    };
  }

  // --- lessons -------------------------------------------------------------------

  async addLesson(projectId: string, dto: SaveLessonDto, actor: Principal) {
    const access = await this.writer(projectId, actor);
    const input = { kind: dto.kind ?? '', text: dto.text ?? '' };
    this.assertLesson(input);
    await this.transactions.execute(async (prisma) => {
      const created = (await this.lessons.create(
        {
          data: {
            companyId: access.project.companyId,
            projectId,
            kind: input.kind,
            text: input.text.trim(),
            createdBy: actor.userId,
          },
          select: { id: true },
        },
        { prisma },
      )) as { id: string };
      await this.audit.record(
        {
          eventType: 'pm.lesson.added',
          companyId: access.project.companyId,
          ...auditActor(actor),
          resourceType: 'project',
          resourceId: projectId,
          after: { lessonId: created.id, kind: input.kind },
        },
        { prisma },
      );
    });
    return this.view(projectId, actor);
  }

  /** Its writer, or whoever runs the project. */
  async updateLesson(
    projectId: string,
    lessonId: string,
    dto: SaveLessonDto,
    actor: Principal,
  ) {
    const access = await this.writer(projectId, actor);
    const lesson = await this.ownLesson(access, lessonId, actor);
    const input = {
      kind: dto.kind ?? lesson.kind,
      text: dto.text ?? lesson.text,
    };
    this.assertLesson(input);
    await this.transactions.execute(async (prisma) => {
      await this.lessons.update(
        {
          where: { id: lessonId },
          data: { kind: input.kind, text: input.text.trim() },
        },
        { prisma },
      );
      await this.audit.record(
        {
          eventType: 'pm.lesson.updated',
          companyId: access.project.companyId,
          ...auditActor(actor),
          resourceType: 'project',
          resourceId: projectId,
          before: { lessonId, kind: lesson.kind, text: lesson.text },
          after: input,
        },
        { prisma },
      );
    });
    return this.view(projectId, actor);
  }

  async removeLesson(projectId: string, lessonId: string, actor: Principal) {
    const access = await this.writer(projectId, actor);
    const lesson = await this.ownLesson(access, lessonId, actor);
    await this.transactions.execute(async (prisma) => {
      await this.lessons.update(
        { where: { id: lessonId }, data: { deletedAt: new Date() } },
        { prisma },
      );
      await this.audit.record(
        {
          eventType: 'pm.lesson.removed',
          companyId: access.project.companyId,
          ...auditActor(actor),
          resourceType: 'project',
          resourceId: projectId,
          before: { lessonId, kind: lesson.kind, text: lesson.text },
        },
        { prisma },
      );
    });
    return this.view(projectId, actor);
  }

  // --- asking to close -----------------------------------------------------------

  async submit(
    projectId: string,
    actor: Principal,
    authorization: string,
    now = new Date(),
  ) {
    const access = await this.editable(projectId, actor);
    const project = access.project;
    const config = await this.config(project.companyId);
    const checks = await this.checks(access, config.documents, actor);
    const problems = closeProblems(checks);
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'closeout', reason })),
      );
    }
    if (!config.typeCode) {
      throw new AppError(
        'CONFLICT',
        'ยังไม่ได้ตั้งประเภทคำขอปิดโครงการในหน้าตั้งค่า CRM',
      );
    }
    const current = await this.current(projectId);
    const facts = (await this.projectRows.findFirst({
      where: { id: projectId },
      select: { contractValue: true },
    })) as { contractValue: { toString(): string } | null } | null;
    const contractValue =
      facts?.contractValue === null || facts?.contractValue === undefined
        ? null
        : Number(facts.contractValue.toString());
    const lessonCount = await this.lessons.count({
      where: { projectId, deletedAt: null },
    });
    const warnings = checks
      .filter((check) => !check.blocking && !check.ok)
      .map((check) => `${check.label}: ${check.detail ?? ''}`.trim());
    let requestId: string | null = null;
    let error: string | null = null;
    try {
      const created = (await this.requests.create(
        {
          type_code: config.typeCode,
          ref_type: 'project',
          ref_id: project.projectNo,
          // `contract_value` is what a matrix level may route on
          form_data: {
            subject: `ขอปิดโครงการ ${project.projectNo} ${project.name}`,
            project_no: project.projectNo,
            contract_no: project.contract.contractNo,
            ...(contractValue !== null
              ? { contract_value: contractValue }
              : {}),
            summary: current?.summary ?? '',
            lessons: lessonCount,
            warnings: warnings.join(' · '),
            detail:
              `${project.projectNo} ${project.name} — ผ่านรายการตรวจครบ · บทเรียน ${lessonCount} ข้อ` +
              (warnings.length ? ` · ข้อสังเกต: ${warnings.join(' · ')}` : ''),
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
      await this.closeouts.upsert({
        where: { projectId },
        create: {
          companyId: project.companyId,
          projectId,
          error,
          createdBy: actor.userId,
        },
        update: { error },
      });
      throw new AppError('CONFLICT', error ?? 'สร้างคำขอไม่ได้');
    }
    await this.transactions.execute(async (prisma) => {
      await prisma.projectCloseout.upsert({
        where: { projectId },
        create: {
          companyId: project.companyId,
          projectId,
          status: 'submitted',
          requestId,
          error,
          submittedAt: now,
          submittedBy: actor.userId,
          decidedAt: null,
          createdBy: actor.userId,
        },
        update: {
          status: 'submitted',
          requestId,
          error,
          submittedAt: now,
          submittedBy: actor.userId,
          decidedAt: null,
          updatedBy: actor.userId,
        },
      });
      await this.audit.record(
        {
          eventType: 'pm.closeout.submitted',
          companyId: project.companyId,
          ...auditActor(actor),
          resourceType: 'project',
          resourceId: projectId,
          after: { requestId, warnings },
        },
        { prisma },
      );
    });
    return this.view(projectId, actor);
  }

  /**
   * The executives' decision, read off its request: approved closes the
   * project; rejected (or cancelled) hands the close-out back to be fixed
   * and asked again. Once only.
   */
  async syncRequest(requestId: string, now = new Date()) {
    const row = (await this.closeouts.findFirst({
      where: { requestId, status: 'submitted' },
    })) as CloseoutRow | null;
    if (!row) return;
    const request = (await this.requestRows.findFirst({
      where: { id: requestId },
      select: { status: true },
    })) as { status: string } | null;
    const state = approvalStateOf(true, request);
    if (state !== 'approved' && state !== 'rejected') return;

    const decided = await this.transactions.execute(async (prisma) => {
      const claimed = await prisma.projectCloseout.updateMany({
        where: { id: row.id, status: 'submitted' },
        data: { status: state, decidedAt: now },
      });
      if (!claimed.count) return false;
      if (state === 'approved') {
        await prisma.project.update({
          where: { id: row.projectId },
          data: { status: 'closed', updatedBy: row.submittedBy },
        });
      }
      await this.audit.record(
        {
          eventType: `pm.closeout.${state}`,
          companyId: row.companyId,
          actorId: null,
          actorUsername: 'system',
          resourceType: 'project',
          resourceId: row.projectId,
          after: { requestId, state },
        },
        { prisma: prisma as never },
      );
      return true;
    });
    if (decided && row.submittedBy) {
      const project = await this.projects.summary(row.projectId);
      if (project) {
        await this.notifications
          .closeDecided(
            row.submittedBy,
            row.companyId,
            project,
            state === 'approved',
          )
          .catch(() => undefined);
      }
    }
  }

  // --- helpers -------------------------------------------------------------------

  private async checks(
    access: Access,
    requiredDocuments: string[],
    actor: Principal,
  ) {
    const project = access.project;
    const projectId = project.id;
    const [
      obligationsOpen,
      issuesOpen,
      decisionsOwed,
      changesPending,
      milestonesOpen,
      uploaded,
      lessons,
      tasksOpen,
      risksOpen,
      payments,
    ] = await Promise.all([
      this.obligations.count({
        where: { contractId: project.contractId, status: 'open' },
      }),
      this.issues.count({ where: { projectId, status: 'open' } }),
      this.customerLogs.owed(projectId),
      this.changes.count({
        where: { projectId, status: { in: ['draft', 'submitted'] } },
      }),
      this.milestones.count({ where: { projectId, status: 'planned' } }),
      this.documents.findMany({
        where: { projectId, deletedAt: null },
        select: { title: true },
      }) as Promise<{ title: string }[]>,
      this.lessons.count({ where: { projectId, deletedAt: null } }),
      // leaves only: a summary task is done when its pieces are
      this.tasks.count({
        where: {
          projectId,
          status: { notIn: ['done', 'cancelled'] },
          children: { none: {} },
        },
      }),
      this.risks.count({ where: { projectId, status: 'open' } }),
      this.payments.view(projectId, actor),
    ]);
    return closeChecks({
      projectStatus: project.status,
      obligationsOpen,
      issuesOpen,
      decisionsOwed,
      changesPending,
      milestonesOpen,
      documentsMissing: missingDocuments(
        requiredDocuments,
        uploaded.map((row) => row.title),
      ),
      lessons,
      tasksOpen,
      risksOpen,
      outstanding: payments.totals.outstanding,
    });
  }

  private async config(companyId: string) {
    const row = (await this.configs.findFirst({
      where: { companyId },
      select: { projectCloseTypeCode: true, projectCloseDocuments: true },
    })) as {
      projectCloseTypeCode: string | null;
      projectCloseDocuments: string[] | null;
    } | null;
    return {
      typeCode: row?.projectCloseTypeCode ?? null,
      // no settings row yet: the schema's own defaults
      documents: (
        row?.projectCloseDocuments ?? ['ใบตรวจรับงาน', 'เอกสารส่งมอบงาน']
      ).filter((title) => title.trim()),
    };
  }

  private async current(projectId: string) {
    return (await this.closeouts.findFirst({
      where: { projectId },
    })) as CloseoutRow | null;
  }

  /** The manager's part, while the close-out is not with the executives. */
  private async editable(projectId: string, actor: Principal) {
    const access = await this.projects.access(projectId, actor);
    if (!access.canEdit) {
      throw new AppError(
        'FORBIDDEN',
        'ปิดโครงการได้เฉพาะผู้จัดการโครงการ หรือผู้มีสิทธิ์จัดการโครงการ ขณะโครงการยังดำเนินอยู่',
      );
    }
    await this.assertOpen(projectId);
    return access;
  }

  /** The team's part (lessons), on the same terms. */
  private async writer(projectId: string, actor: Principal) {
    const access = await this.projects.access(projectId, actor);
    if (!this.mayWrite(access, actor)) {
      throw new AppError(
        'FORBIDDEN',
        'บันทึกบทเรียนได้เฉพาะทีมโครงการ ขณะโครงการยังดำเนินอยู่',
      );
    }
    await this.assertOpen(projectId);
    return access;
  }

  private async assertOpen(projectId: string) {
    const current = await this.current(projectId);
    if (!closeoutEditable(current?.status ?? null)) {
      throw new AppError(
        'CONFLICT',
        current?.status === 'approved'
          ? 'โครงการปิดแล้ว'
          : 'ส่งคำขอปิดโครงการแล้ว — แก้ไขได้อีกเมื่อคำขอไม่ได้รับอนุมัติ',
      );
    }
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

  private async ownLesson(access: Access, lessonId: string, actor: Principal) {
    const lesson = (await this.lessons.findFirst({
      where: { id: lessonId, projectId: access.project.id, deletedAt: null },
      select: { id: true, kind: true, text: true, createdBy: true },
    })) as { id: string; kind: string; text: string; createdBy: string } | null;
    if (!lesson) throw new AppError('NOT_FOUND', 'ไม่พบบทเรียน');
    if (!access.canEdit && lesson.createdBy !== actor.userId) {
      throw new AppError(
        'FORBIDDEN',
        'แก้ไขได้เฉพาะผู้บันทึก หรือผู้จัดการโครงการ',
      );
    }
    return lesson;
  }

  private assertLesson(input: { kind: string; text: string }) {
    const problems = lessonProblems(input);
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'lesson', reason })),
      );
    }
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
