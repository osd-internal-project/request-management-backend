import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Inject, Injectable } from '@nestjs/common';
import {
  AppError,
  AuditWriter,
  auditActor,
  hasPermission,
  OBJECT_STORAGE,
  Principal,
  PrismaTransactionService,
} from '@request-management/share';
import type { ObjectStorage } from '@request-management/share';
import { EVIDENCE_TYPES, MAX_EVIDENCE_BYTES } from '../pm/milestones.service';
import { ProjectMilestoneRepository } from '../pm/project.repositories';
import { safeFileName } from '../requests/attachments.service';
import { DeliveriesService } from './deliveries.service';
import { DELIVERY_WORK_TYPES } from './delivery-docs-rules';
import { DeliveryDocsState } from './delivery-docs.state';
import {
  ProjectDeliveryDocumentRepository,
  ProjectInstallConfirmationRepository,
} from './delivery.repositories';

/** Most files one phase keeps. */
const MAX_DOCS_PER_PHASE = 100;

interface DocumentRow {
  id: string;
  companyId: string;
  projectId: string;
  milestoneId: string;
  title: string;
  note: string | null;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  storageKey: string;
  uploadedBy: string;
  uploadedAt: Date;
}

/**
 * CD-251 ชุดเอกสารส่งมอบ (part of CD-20 Delivery).
 *
 * Each phase keeps its delivery documents in one place: the ones its work
 * types require (CRM settings, per work type) and anything else worth
 * handing over. A required document still missing on the next phase stops
 * the acceptance booking through the project readiness check (CD-225 →
 * CD-189). As-built, tests and software documents are kept where they are
 * (Engineer) and shown beside the pack, not attached twice.
 *
 * Who: whoever sees the project's delivery plan reads; its team attaches
 * while the project runs; a file is removed by whoever attached it or by
 * those who plan the delivery.
 */
@Injectable()
export class DeliveryDocsService {
  constructor(
    private readonly deliveries: DeliveriesService,
    private readonly state: DeliveryDocsState,
    private readonly milestones: ProjectMilestoneRepository,
    private readonly documents: ProjectDeliveryDocumentRepository,
    private readonly confirmations: ProjectInstallConfirmationRepository,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  /** Every phase with a trip, its pack, and which one the readiness checks. */
  async view(actor: Principal, projectId: string) {
    const { project, canEdit } = await this.deliveries.access(actor, projectId);
    const running = project.status === 'active' || project.status === 'on_hold';
    const [milestones, next, confirmed] = await Promise.all([
      this.milestones.findMany({
        where: { projectId, status: { not: 'cancelled' } },
        select: { id: true, seq: true, title: true, status: true },
        orderBy: { seq: 'asc' },
      }) as unknown as Promise<
        { id: string; seq: number; title: string; status: string }[]
      >,
      this.state.forProject(projectId, project.companyId),
      // CD-254 — each phase's confirmed installation
      this.confirmations.findMany({
        where: { projectId },
        select: {
          milestoneId: true,
          confirmedAt: true,
          confirmedBy: true,
          note: true,
        },
      }) as unknown as Promise<
        {
          milestoneId: string;
          confirmedAt: Date;
          confirmedBy: string;
          note: string;
        }[]
      >,
    ]);
    const installed = new Map(confirmed.map((c) => [c.milestoneId, c]));
    const phases = await Promise.all(
      milestones.map(async (milestone) => {
        const pack = await this.state.pack(
          projectId,
          project.companyId,
          milestone.id,
        );
        return {
          milestone,
          next: next?.milestone.id === milestone.id,
          installed: installed.get(milestone.id) ?? null,
          workTypes: pack.workTypes,
          complete: pack.complete,
          missing: pack.missing,
          required: pack.required.map((row) => ({
            title: row.title,
            documents: row.documents.map((d) =>
              this.docView(d, actor, canEdit),
            ),
          })),
          extras: pack.extras.map((d) => this.docView(d, actor, canEdit)),
        };
      }),
    );
    return {
      project: { id: project.id, status: project.status },
      canAttach: running,
      // CD-254 — the project's manager confirms installation
      canConfirmInstall:
        running &&
        (hasPermission(actor, 'pm.project.manage') ||
          project.managerUserId === actor.userId),
      workTypes: DELIVERY_WORK_TYPES,
      // a phase with nothing planned and nothing attached is noise
      phases: phases.filter(
        (p) => p.workTypes.length || p.extras.length || p.required.length,
      ),
      next: next ? next.milestone.id : null,
    };
  }

  async attach(
    actor: Principal,
    projectId: string,
    body: { milestone_id?: string; title?: string; note?: string },
    file:
      | { originalname: string; mimetype: string; size: number; buffer: Buffer }
      | undefined,
  ) {
    const { project } = await this.deliveries.access(actor, projectId);
    if (project.status !== 'active' && project.status !== 'on_hold') {
      throw new AppError('CONFLICT', 'โครงการปิดแล้ว แนบเอกสารไม่ได้');
    }
    const title = (body.title ?? '').trim();
    const problems: string[] = [];
    if (!title) problems.push('ต้องระบุชื่อเอกสาร');
    if (title.length > 255) problems.push('ชื่อเอกสารยาวเกิน 255 ตัวอักษร');
    const milestone = body.milestone_id
      ? await this.milestones.findFirst({
          where: {
            id: body.milestone_id,
            projectId,
            status: { not: 'cancelled' },
          },
          select: { id: true },
        })
      : null;
    if (!milestone) problems.push('ต้องเลือกเฟส (หมุดหมาย) ของโครงการนี้');
    if (!file) problems.push('ต้องแนบไฟล์');
    if (file && !(EVIDENCE_TYPES as readonly string[]).includes(file.mimetype))
      problems.push('แนบได้เฉพาะรูป PDF Word หรือ Excel');
    if (file && file.size > MAX_EVIDENCE_BYTES)
      problems.push('ไฟล์ใหญ่เกิน 25 MB');
    if (
      milestone &&
      (await this.documents.count({
        where: { projectId, milestoneId: milestone.id, deletedAt: null },
      })) >= MAX_DOCS_PER_PHASE
    ) {
      problems.push(`เฟสหนึ่งเก็บได้ไม่เกิน ${MAX_DOCS_PER_PHASE} ไฟล์`);
    }
    if (problems.length || !file || !milestone) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'document', reason })),
      );
    }
    const id = randomUUID();
    const name = safeFileName(file.originalname);
    const key = `projects/${projectId}/delivery-docs/${id}/${name}`;
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
              companyId: project.companyId,
              projectId,
              milestoneId: milestone.id,
              title,
              note: body.note?.trim() || null,
              fileName: name,
              mimeType: file.mimetype,
              sizeBytes: file.size,
              storageKey: key,
              uploadedBy: actor.userId,
            },
          },
          { prisma },
        );
        await this.audit.record(
          {
            eventType: 'delivery.document.attached',
            companyId: project.companyId,
            ...auditActor(actor),
            resourceType: 'project',
            resourceId: projectId,
            after: {
              documentId: id,
              milestoneId: milestone.id,
              title,
              fileName: name,
            },
          },
          { prisma },
        );
      });
    } catch (error) {
      await this.storage.remove(key).catch(() => undefined);
      throw error;
    }
    return this.view(actor, projectId);
  }

  async remove(actor: Principal, projectId: string, documentId: string) {
    const { project, canEdit } = await this.deliveries.access(actor, projectId);
    const row = await this.requireDocument(projectId, documentId);
    if (row.uploadedBy !== actor.userId && !canEdit) {
      throw new AppError(
        'FORBIDDEN',
        'ลบได้เฉพาะผู้แนบ ทีม Delivery หรือผู้จัดการโครงการ',
      );
    }
    await this.documents.update({
      where: { id: documentId },
      data: { deletedAt: new Date(), deletedBy: actor.userId },
    });
    await this.audit.record({
      eventType: 'delivery.document.removed',
      companyId: project.companyId,
      ...auditActor(actor),
      resourceType: 'project',
      resourceId: projectId,
      before: { documentId, title: row.title, fileName: row.fileName },
    });
    return this.view(actor, projectId);
  }

  async download(
    actor: Principal,
    projectId: string,
    documentId: string,
  ): Promise<{ stream: Readable; fileName: string; mimeType: string }> {
    await this.deliveries.access(actor, projectId);
    const row = await this.requireDocument(projectId, documentId);
    return {
      stream: await this.storage.get(row.storageKey),
      fileName: row.fileName,
      mimeType: row.mimeType,
    };
  }

  // --- helpers ----------------------------------------------------------------

  private async requireDocument(projectId: string, id: string) {
    const row = (await this.documents.findFirst({
      where: { id, projectId, deletedAt: null },
    })) as unknown as DocumentRow | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบเอกสารที่ระบุ');
    return row;
  }

  private docView(row: DocumentRow, actor: Principal, canEdit: boolean) {
    return {
      id: row.id,
      title: row.title,
      note: row.note,
      fileName: row.fileName,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      uploadedBy: row.uploadedBy,
      uploadedAt: row.uploadedAt,
      canRemove: canEdit || row.uploadedBy === actor.userId,
    };
  }
}
