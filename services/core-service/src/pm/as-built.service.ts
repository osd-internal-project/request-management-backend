import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Inject, Injectable } from '@nestjs/common';
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
import { CrmConfigRepository } from '../crm/segment.repositories';
import { safeFileName } from '../requests/attachments.service';
import {
  asBuiltRefs,
  asBuiltStatus,
  DEFAULT_AS_BUILT_DOCUMENTS,
  deviationProblems,
  MAX_AS_BUILT_DOCUMENTS,
} from './as-built-rules';
import { AttachCloseDocumentDto, SaveDeviationDto } from './dto/project.dto';
import { EVIDENCE_TYPES, MAX_EVIDENCE_BYTES } from './milestones.service';
import {
  ProjectAsBuiltDeviationRepository,
  ProjectAsBuiltDocumentRepository,
  ProjectChangeRequestRepository,
  ProjectRepository,
} from './project.repositories';
import { ProjectsService } from './projects.service';

interface DocumentRow {
  id: string;
  title: string;
  note: string | null;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  uploadedBy: string;
  uploadedAt: Date;
}

interface DeviationRow {
  id: string;
  seq: number;
  reference: string | null;
  planned: string;
  built: string;
  reason: string | null;
  affectsScope: boolean;
  changeRequestId: string | null;
  createdBy: string;
}

interface UploadedFile {
  readonly originalname: string;
  readonly mimetype: string;
  readonly size: number;
  readonly buffer: Buffer;
}

type Access = Awaited<ReturnType<ProjectsService['access']>>;

/**
 * CD-226 เอกสารสภาพจริง (As-built) — the project as it was built: the
 * as-built documents every project must leave (named in CRM settings), and
 * every point where what was built differs from what was sold (a BOQ or
 * scope line of the baseline), each with its reason — one that changes the
 * scope settled only by an approved change request (CD-185). Complete is a
 * check the readiness review (CD-225) makes itself.
 *
 * Who: whoever sees the project reads it; the team uploads documents and
 * records deviations; `pm.project.manage` or the project's manager links a
 * deviation to its change request and removes what is not theirs.
 */
@Injectable()
export class AsBuiltService {
  constructor(
    private readonly projects: ProjectsService,
    private readonly projectRows: ProjectRepository,
    private readonly documents: ProjectAsBuiltDocumentRepository,
    private readonly deviations: ProjectAsBuiltDeviationRepository,
    private readonly changes: ProjectChangeRequestRepository,
    private readonly configs: CrmConfigRepository,
    private readonly people: CompanyMemberRepository,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  async view(projectId: string, actor: Principal) {
    const access = await this.projects.access(projectId, actor);
    const [documents, deviations, required, refs, changes] = await Promise.all([
      this.documentRows(projectId),
      this.deviationRows(projectId),
      this.required(access.project.companyId),
      this.refs(projectId),
      this.changeRows(projectId),
    ]);
    const status = this.statusOf(required, documents, deviations, changes);
    const names = await this.displayNames([
      ...documents.map((row) => row.uploadedBy),
      ...deviations.map((row) => row.createdBy),
    ]);
    const refLabel = new Map(refs.map((row) => [row.ref, row.label]));
    return {
      canEdit: access.canEdit,
      canWrite: this.mayWrite(access, actor),
      ...status,
      required: required.map((title) => ({
        title,
        // the newest upload under the title is the current one
        documentIds: documents
          .filter((row) => row.title.trim() === title.trim())
          .map((row) => row.id),
      })),
      documents: documents.map((row) => ({
        ...row,
        uploadedByName: names.get(row.uploadedBy) ?? null,
        mayRemove: access.canEdit || row.uploadedBy === actor.userId,
      })),
      deviations: deviations.map((row) => {
        const change = changes.find((item) => item.id === row.changeRequestId);
        return {
          ...row,
          label: `D-${row.seq}`,
          referenceLabel: row.reference
            ? (refLabel.get(row.reference) ?? row.reference)
            : null,
          change: change
            ? {
                id: change.id,
                label: `CR-${change.seq}`,
                status: change.status,
              }
            : null,
          createdByName: names.get(row.createdBy) ?? null,
          mayEdit:
            this.mayWrite(access, actor) &&
            (access.canEdit || row.createdBy === actor.userId),
        };
      }),
      refs,
      changes: changes.map((row) => ({
        id: row.id,
        label: `CR-${row.seq}: ${row.title}`,
        status: row.status,
      })),
    };
  }

  /** For readiness (CD-225) and acceptance (CD-189). */
  async state(projectId: string, companyId: string) {
    const [documents, deviations, required, changes] = await Promise.all([
      this.documentRows(projectId),
      this.deviationRows(projectId),
      this.required(companyId),
      this.changeRows(projectId),
    ]);
    return this.statusOf(required, documents, deviations, changes);
  }

  // --- documents ---------------------------------------------------------------------

  async attach(
    projectId: string,
    body: AttachCloseDocumentDto,
    file: UploadedFile | undefined,
    actor: Principal,
    now = new Date(),
  ) {
    const access = await this.writer(projectId, actor);
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
    if (
      (await this.documents.count({ where: { projectId, deletedAt: null } })) >=
      MAX_AS_BUILT_DOCUMENTS
    ) {
      problems.push(`แนบเอกสารได้ไม่เกิน ${MAX_AS_BUILT_DOCUMENTS} ไฟล์`);
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
    const key = `projects/${projectId}/as-built/${id}/${name}`;
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
            eventType: 'pm.as_built.document_attached',
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

  /** Off the list (its uploader or the manager); the file stays. */
  async detach(projectId: string, documentId: string, actor: Principal) {
    const access = await this.writer(projectId, actor);
    const found = (await this.documents.findFirst({
      where: { id: documentId, projectId, deletedAt: null },
      select: { id: true, title: true, uploadedBy: true },
    })) as { id: string; title: string; uploadedBy: string } | null;
    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบเอกสาร');
    if (!access.canEdit && found.uploadedBy !== actor.userId) {
      throw new AppError(
        'FORBIDDEN',
        'นำออกได้เฉพาะผู้แนบ หรือผู้จัดการโครงการ',
      );
    }
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
          eventType: 'pm.as_built.document_removed',
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

  // --- deviations --------------------------------------------------------------------

  async addDeviation(
    projectId: string,
    dto: SaveDeviationDto,
    actor: Principal,
  ) {
    const access = await this.writer(projectId, actor);
    const input = await this.deviationInput(projectId, dto, null, access);
    await this.transactions.execute(async (prisma) => {
      const last = await prisma.projectAsBuiltDeviation.findFirst({
        where: { projectId },
        orderBy: { seq: 'desc' },
        select: { seq: true },
      });
      const row = await prisma.projectAsBuiltDeviation.create({
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
          eventType: 'pm.as_built.deviation_added',
          companyId: access.project.companyId,
          ...auditActor(actor),
          resourceType: 'project',
          resourceId: projectId,
          after: { deviationId: row.id, label: `D-${row.seq}`, ...input },
        },
        { prisma },
      );
    });
    return this.view(projectId, actor);
  }

  /** Its writer or the manager; only the manager links a change request. */
  async updateDeviation(
    projectId: string,
    deviationId: string,
    dto: SaveDeviationDto,
    actor: Principal,
  ) {
    const access = await this.writer(projectId, actor);
    const current = await this.requireDeviation(projectId, deviationId);
    if (!access.canEdit && current.createdBy !== actor.userId) {
      throw new AppError(
        'FORBIDDEN',
        'แก้ได้เฉพาะผู้บันทึก หรือผู้จัดการโครงการ',
      );
    }
    const input = await this.deviationInput(projectId, dto, current, access);
    await this.transactions.execute(async (prisma) => {
      await this.deviations.update(
        {
          where: { id: deviationId },
          data: { ...input, updatedBy: actor.userId },
        },
        { prisma },
      );
      await this.audit.record(
        {
          eventType: 'pm.as_built.deviation_updated',
          companyId: access.project.companyId,
          ...auditActor(actor),
          resourceType: 'project',
          resourceId: projectId,
          before: { deviationId, ...current },
          after: { deviationId, ...input },
        },
        { prisma },
      );
    });
    return this.view(projectId, actor);
  }

  async removeDeviation(
    projectId: string,
    deviationId: string,
    actor: Principal,
  ) {
    const access = await this.writer(projectId, actor);
    const current = await this.requireDeviation(projectId, deviationId);
    if (!access.canEdit && current.createdBy !== actor.userId) {
      throw new AppError(
        'FORBIDDEN',
        'ลบได้เฉพาะผู้บันทึก หรือผู้จัดการโครงการ',
      );
    }
    await this.transactions.execute(async (prisma) => {
      await this.deviations.update(
        {
          where: { id: deviationId },
          data: { deletedAt: new Date(), updatedBy: actor.userId },
        },
        { prisma },
      );
      await this.audit.record(
        {
          eventType: 'pm.as_built.deviation_removed',
          companyId: access.project.companyId,
          ...auditActor(actor),
          resourceType: 'project',
          resourceId: projectId,
          before: { deviationId, label: `D-${current.seq}` },
        },
        { prisma },
      );
    });
    return this.view(projectId, actor);
  }

  // --- helpers -----------------------------------------------------------------------

  private async deviationInput(
    projectId: string,
    dto: SaveDeviationDto,
    current: DeviationRow | null,
    access: Access,
  ) {
    const reference =
      dto.reference === undefined
        ? (current?.reference ?? null)
        : dto.reference || null;
    const input = {
      reference,
      planned: (dto.planned ?? current?.planned ?? '').trim(),
      built: (dto.built ?? current?.built ?? '').trim(),
      reason:
        dto.reason === undefined
          ? (current?.reason ?? null)
          : dto.reason.trim() || null,
      affectsScope: dto.affects_scope ?? current?.affectsScope ?? false,
      changeRequestId: current?.changeRequestId ?? null,
    };
    if (dto.change_request_id !== undefined) {
      if (!access.canEdit) {
        throw new AppError(
          'FORBIDDEN',
          'ผูกคำขอเปลี่ยนแปลงได้เฉพาะผู้จัดการโครงการ',
        );
      }
      input.changeRequestId = dto.change_request_id || null;
      if (input.changeRequestId) {
        const found = await this.changes.count({
          where: { id: input.changeRequestId, projectId },
        });
        if (!found) {
          throw new AppError(
            'VALIDATION_FAILED',
            'คำขอเปลี่ยนแปลงไม่ได้อยู่ในโครงการนี้',
            [{ field: 'change_request_id', reason: 'not_found' }],
          );
        }
      }
    }
    const refs = (await this.refs(projectId)).map((row) => row.ref);
    const problems = deviationProblems({ ...input, refs });
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'deviation', reason })),
      );
    }
    return input;
  }

  private statusOf(
    required: string[],
    documents: DocumentRow[],
    deviations: DeviationRow[],
    changes: { id: string; status: string }[],
  ) {
    return asBuiltStatus({
      required,
      uploaded: documents.map((row) => row.title),
      deviations: deviations.map((row) => ({
        label: `D-${row.seq}`,
        reason: row.reason,
        affectsScope: row.affectsScope,
        changeStatus:
          changes.find((change) => change.id === row.changeRequestId)?.status ??
          null,
      })),
    });
  }

  private async required(companyId: string) {
    const row = (await this.configs.findFirst({
      where: { companyId },
      select: { projectAsBuiltDocuments: true },
    })) as { projectAsBuiltDocuments: string[] | null } | null;
    return (row?.projectAsBuiltDocuments ?? DEFAULT_AS_BUILT_DOCUMENTS).filter(
      (title) => title.trim(),
    );
  }

  private async refs(projectId: string) {
    const project = (await this.projectRows.findFirst({
      where: { id: projectId },
      select: { baseline: true },
    })) as { baseline: unknown } | null;
    return asBuiltRefs(project?.baseline ?? null);
  }

  private async documentRows(projectId: string) {
    return (await this.documents.findMany({
      where: { projectId, deletedAt: null },
      orderBy: { uploadedAt: 'desc' },
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
    })) as DocumentRow[];
  }

  private async deviationRows(projectId: string) {
    return (await this.deviations.findMany({
      where: { projectId, deletedAt: null },
      orderBy: { seq: 'asc' },
      select: {
        id: true,
        seq: true,
        reference: true,
        planned: true,
        built: true,
        reason: true,
        affectsScope: true,
        changeRequestId: true,
        createdBy: true,
      },
    })) as DeviationRow[];
  }

  private async changeRows(projectId: string) {
    return (await this.changes.findMany({
      where: { projectId, status: { not: 'cancelled' } },
      orderBy: { seq: 'asc' },
      select: { id: true, seq: true, title: true, status: true },
    })) as { id: string; seq: number; title: string; status: string }[];
  }

  private async requireDeviation(projectId: string, deviationId: string) {
    const row = (await this.deviations.findFirst({
      where: { id: deviationId, projectId, deletedAt: null },
    })) as DeviationRow | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบจุดที่ต่างจากแบบ');
    return row;
  }

  private async writer(projectId: string, actor: Principal) {
    const access = await this.projects.access(projectId, actor);
    if (!this.mayWrite(access, actor)) {
      throw new AppError(
        'FORBIDDEN',
        'บันทึกเอกสารสภาพจริงได้เฉพาะทีมโครงการ ขณะโครงการยังดำเนินอยู่',
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
