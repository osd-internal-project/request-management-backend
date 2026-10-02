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
import { AttachSoftwareDocumentDto } from './dto/project.dto';
import { EVIDENCE_TYPES, MAX_EVIDENCE_BYTES } from './milestones.service';
import {
  ProjectDeploymentRepository,
  ProjectEnvironmentRepository,
  ProjectReleaseRepository,
  ProjectSoftwareDocumentRepository,
  ProjectTaskRepository,
} from './project.repositories';
import { ProjectsService } from './projects.service';
import { currentOf } from './release-rules';
import {
  DEFAULT_SOFTWARE_DOCUMENTS,
  MAX_SOFTWARE_DOCUMENTS,
  softwareDocsStatus,
  targetRelease,
} from './software-docs-rules';

interface DocumentRow {
  id: string;
  releaseId: string;
  title: string;
  note: string | null;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  storageKey: string;
  uploadedBy: string;
  uploadedAt: Date;
}

interface UploadedFile {
  readonly originalname: string;
  readonly mimetype: string;
  readonly size: number;
  readonly buffer: Buffer;
}

type Access = Awaited<ReturnType<ProjectsService['access']>>;

const DOC_SELECT = {
  id: true,
  releaseId: true,
  title: true,
  note: true,
  fileName: true,
  mimeType: true,
  sizeBytes: true,
  storageKey: true,
  uploadedBy: true,
  uploadedAt: true,
} as const;

/**
 * CD-215 เอกสารซอฟต์แวร์ — the software's as-built: specifications,
 * manuals and interface documents, named in CRM settings, each file for one
 * release (CD-214). Complete = every named document has a file for the
 * version that runs on production (the newest release where no production
 * environment is kept). A project with software work — a development plan
 * (CD-212) or environments — must be complete before the readiness review
 * (CD-225) passes, as installation work must leave its as-built (CD-226).
 *
 * Who: whoever sees the project reads it; the team uploads and carries
 * documents forward; the uploader or the manager removes one.
 */
@Injectable()
export class SoftwareDocsService {
  constructor(
    private readonly projects: ProjectsService,
    private readonly documents: ProjectSoftwareDocumentRepository,
    private readonly releases: ProjectReleaseRepository,
    private readonly environments: ProjectEnvironmentRepository,
    private readonly deployments: ProjectDeploymentRepository,
    private readonly tasks: ProjectTaskRepository,
    private readonly configs: CrmConfigRepository,
    private readonly people: CompanyMemberRepository,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  async view(projectId: string, actor: Principal) {
    const access = await this.projects.access(projectId, actor);
    const [software, documents, releases, required, target] = await Promise.all(
      [
        this.isSoftware(projectId),
        this.documentRows(projectId),
        this.releaseRows(projectId),
        this.required(access.project.companyId),
        this.target(projectId),
      ],
    );
    const status = softwareDocsStatus({ required, target, documents });
    const names = await this.displayNames(
      documents.map((row) => row.uploadedBy),
    );
    const version = new Map(releases.map((row) => [row.id, row.version]));
    return {
      software,
      canEdit: access.canEdit,
      canWrite: this.mayWrite(access, actor),
      ...status,
      releases: releases.map((row) => ({ id: row.id, version: row.version })),
      required: required.map((title) => ({
        title,
        // the target version's files under the title
        documentIds: documents
          .filter(
            (row) => row.title.trim() === title && row.releaseId === target?.id,
          )
          .map((row) => row.id),
      })),
      documents: documents.map(({ storageKey: _key, ...row }) => ({
        ...row,
        version: version.get(row.releaseId) ?? '',
        uploadedByName: names.get(row.uploadedBy) ?? null,
        mayRemove: access.canEdit || row.uploadedBy === actor.userId,
      })),
    };
  }

  /**
   * For readiness (CD-225): null when the project has no software work,
   * so the check is not asked of installation-only projects.
   */
  async state(projectId: string, companyId: string) {
    if (!(await this.isSoftware(projectId))) return null;
    const [documents, required, target] = await Promise.all([
      this.documentRows(projectId),
      this.required(companyId),
      this.target(projectId),
    ]);
    return softwareDocsStatus({ required, target, documents });
  }

  async attach(
    projectId: string,
    body: AttachSoftwareDocumentDto,
    file: UploadedFile | undefined,
    actor: Principal,
    now = new Date(),
  ) {
    const access = await this.writer(projectId, actor);
    const title = (body.title ?? '').trim();
    const problems: string[] = [];
    if (!title) problems.push('ต้องระบุชื่อเอกสาร');
    if (title.length > 255) problems.push('ชื่อเอกสารยาวเกิน 255 ตัวอักษร');
    const release = body.release_id
      ? await this.findRelease(projectId, body.release_id)
      : null;
    if (!release) problems.push('ต้องเลือกเวอร์ชันที่เอกสารนี้อธิบาย');
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
    await this.assertRoom(projectId, problems);
    if (problems.length || !file || !release) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'document', reason })),
      );
    }
    const id = randomUUID();
    const name = safeFileName(file.originalname);
    const key = `projects/${projectId}/software-docs/${id}/${name}`;
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
              releaseId: release.id,
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
            eventType: 'pm.software_doc.attached',
            companyId: access.project.companyId,
            ...auditActor(actor),
            resourceType: 'project',
            resourceId: projectId,
            after: {
              documentId: id,
              title,
              version: release.version,
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
    return this.view(projectId, actor);
  }

  /**
   * The same file still describes a later release (nothing in it changed):
   * a new row for that release over the same stored object.
   */
  async carry(
    projectId: string,
    documentId: string,
    releaseId: string,
    actor: Principal,
    now = new Date(),
  ) {
    const access = await this.writer(projectId, actor);
    const source = await this.requireDocument(projectId, documentId);
    const release = await this.findRelease(projectId, releaseId);
    if (!release) throw new AppError('NOT_FOUND', 'ไม่พบเวอร์ชันนี้');
    const problems: string[] = [];
    if (source.releaseId === release.id) {
      problems.push('เอกสารนี้เป็นของเวอร์ชันนี้อยู่แล้ว');
    }
    const already = await this.documents.count({
      where: {
        projectId,
        releaseId: release.id,
        storageKey: source.storageKey,
        deletedAt: null,
      },
    });
    if (already) problems.push('เวอร์ชันนี้มีไฟล์นี้แล้ว');
    await this.assertRoom(projectId, problems);
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'release_id', reason })),
      );
    }
    await this.transactions.execute(async (prisma) => {
      const row = await prisma.projectSoftwareDocument.create({
        data: {
          companyId: access.project.companyId,
          projectId,
          releaseId: release.id,
          title: source.title,
          note: source.note,
          fileName: source.fileName,
          mimeType: source.mimeType,
          sizeBytes: source.sizeBytes,
          storageKey: source.storageKey,
          uploadedBy: actor.userId,
          uploadedAt: now,
        },
        select: { id: true },
      });
      await this.audit.record(
        {
          eventType: 'pm.software_doc.carried',
          companyId: access.project.companyId,
          ...auditActor(actor),
          resourceType: 'project',
          resourceId: projectId,
          after: {
            documentId: row.id,
            fromDocumentId: source.id,
            title: source.title,
            version: release.version,
          },
        },
        { prisma },
      );
    });
    return this.view(projectId, actor);
  }

  /** Off the list (its uploader or the manager); the file stays. */
  async detach(projectId: string, documentId: string, actor: Principal) {
    const access = await this.writer(projectId, actor);
    const found = await this.requireDocument(projectId, documentId);
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
          eventType: 'pm.software_doc.removed',
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
    const row = await this.requireDocument(projectId, documentId);
    return {
      stream: await this.storage.get(row.storageKey),
      fileName: row.fileName,
      mimeType: row.mimeType,
    };
  }

  // --- helpers -----------------------------------------------------------------------

  /** Software work: a development plan (CD-212) or environments (CD-214). */
  private async isSoftware(projectId: string) {
    const [iterations, environments] = await Promise.all([
      this.tasks.count({
        where: {
          projectId,
          devKind: 'iteration',
          status: { not: 'cancelled' },
        },
      }),
      this.environments.count({ where: { projectId, deletedAt: null } }),
    ]);
    return iterations > 0 || environments > 0;
  }

  /** The version the documents must describe. */
  private async target(projectId: string) {
    const [production, latest] = await Promise.all([
      this.environments.findMany({
        where: { projectId, kind: 'production', deletedAt: null },
        select: { id: true },
      }) as Promise<{ id: string }[]>,
      this.releases.findFirst({
        where: { projectId },
        orderBy: { createdAt: 'desc' },
        select: { id: true, version: true },
      }) as Promise<{ id: string; version: string } | null>,
    ]);
    let running: { id: string; version: string } | null = null;
    if (production.length) {
      const deployed = (await this.deployments.findMany({
        where: { environmentId: { in: production.map((row) => row.id) } },
        select: {
          environmentId: true,
          deployedAt: true,
          release: { select: { id: true, version: true } },
        },
      })) as unknown as {
        environmentId: string;
        deployedAt: Date;
        release: { id: string; version: string };
      }[];
      // with more than one production, the most recent deployment among them
      const newest = [...currentOf(deployed).values()].sort(
        (a, b) => b.deployedAt.getTime() - a.deployedAt.getTime(),
      )[0];
      running = newest?.release ?? null;
    }
    return targetRelease({
      hasProduction: production.length > 0,
      production: running,
      latest,
    });
  }

  private async required(companyId: string) {
    const row = (await this.configs.findFirst({
      where: { companyId },
      select: { projectSoftwareDocuments: true },
    })) as { projectSoftwareDocuments: string[] | null } | null;
    return [
      ...new Set(
        (row?.projectSoftwareDocuments ?? DEFAULT_SOFTWARE_DOCUMENTS)
          .map((title) => title.trim())
          .filter(Boolean),
      ),
    ];
  }

  private async documentRows(projectId: string) {
    return (await this.documents.findMany({
      where: { projectId, deletedAt: null },
      orderBy: { uploadedAt: 'desc' },
      select: DOC_SELECT,
    })) as DocumentRow[];
  }

  private async releaseRows(projectId: string) {
    return (await this.releases.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, version: true },
    })) as { id: string; version: string }[];
  }

  private async findRelease(projectId: string, releaseId: string) {
    return (await this.releases.findFirst({
      where: { id: releaseId, projectId },
      select: { id: true, version: true },
    })) as { id: string; version: string } | null;
  }

  private async requireDocument(projectId: string, documentId: string) {
    const row = (await this.documents.findFirst({
      where: { id: documentId, projectId, deletedAt: null },
      select: DOC_SELECT,
    })) as DocumentRow | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบเอกสาร');
    return row;
  }

  private async assertRoom(projectId: string, problems: string[]) {
    if (
      (await this.documents.count({ where: { projectId, deletedAt: null } })) >=
      MAX_SOFTWARE_DOCUMENTS
    ) {
      problems.push(`แนบเอกสารได้ไม่เกิน ${MAX_SOFTWARE_DOCUMENTS} ไฟล์`);
    }
  }

  private async writer(projectId: string, actor: Principal) {
    const access = await this.projects.access(projectId, actor);
    if (!this.mayWrite(access, actor)) {
      throw new AppError(
        'FORBIDDEN',
        'บันทึกเอกสารซอฟต์แวร์ได้เฉพาะทีมโครงการ ขณะโครงการยังดำเนินอยู่',
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
