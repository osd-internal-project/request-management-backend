import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AppError,
  AuditWriter,
  auditActor,
  OBJECT_STORAGE,
  Principal,
  PrismaTransactionService,
  salesAccessSubject,
  visibleLeadsWhere,
} from '@request-management/share';
import type { ObjectStorage } from '@request-management/share';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { safeFileName } from '../requests/attachments.service';
import { LeadFileRepository, LeadRepository } from './sales.repositories';

/** A proposal deck with images fits; a video does not. */
export const MAX_LEAD_FILE_BYTES = 20 * 1024 * 1024;
export const LEAD_FILE_KINDS = ['proposal', 'other'] as const;
export type LeadFileKind = (typeof LEAD_FILE_KINDS)[number];

/** Documents and pictures a salesperson sends a customer — nothing runnable. */
export const LEAD_FILE_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/jpeg',
  'image/png',
] as const;

export interface UploadedLeadFile {
  readonly originalname: string;
  readonly mimetype: string;
  readonly size: number;
  readonly buffer: Buffer;
}

interface LeadFileRow {
  id: string;
  companyId: string;
  leadId: string;
  kind: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  storageKey: string;
  source: string;
  uploadedBy: string | null;
  uploadedAt: Date;
}

const FILE_SELECT = {
  id: true,
  companyId: true,
  leadId: true,
  kind: true,
  fileName: true,
  mimeType: true,
  sizeBytes: true,
  storageKey: true,
  source: true,
  uploadedBy: true,
  uploadedAt: true,
} as const;

export const isLeadFileKind = (value: unknown): value is LeadFileKind =>
  typeof value === 'string' &&
  (LEAD_FILE_KINDS as readonly string[]).includes(value);

/**
 * Files on a Lead (6 พ.ย. 2569) — chiefly the proposal Vuvagent drafts for the
 * customer, which the thank-you email attaches. Stored like visit photos: the
 * bytes first, the row second, so a row always has a file. Who sees a file is
 * who sees the Lead (SCOPE-03: out of reach = 404). Removal is a soft delete.
 */
@Injectable()
export class LeadFilesService {
  private readonly logger = new Logger(LeadFilesService.name);

  constructor(
    private readonly leads: LeadRepository,
    private readonly files: LeadFileRepository,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  async list(leadId: string, actor: Principal) {
    await this.requireLead(leadId, actor);
    const rows = (await this.files.findMany({
      where: { leadId, deletedAt: null },
      orderBy: { uploadedAt: 'desc' },
      select: FILE_SELECT,
    })) as LeadFileRow[];
    return rows.map((row) => this.view(row));
  }

  async upload(
    leadId: string,
    kind: unknown,
    file: UploadedLeadFile | undefined,
    actor: Principal,
  ) {
    if (!file) {
      throw new AppError('VALIDATION_FAILED', 'กรุณาเลือกไฟล์', [
        { field: 'file', reason: 'required' },
      ]);
    }
    const fileKind = kind === undefined || kind === '' ? 'other' : kind;
    if (!isLeadFileKind(fileKind)) {
      throw new AppError(
        'VALIDATION_FAILED',
        `ประเภทไฟล์ต้องเป็น ${LEAD_FILE_KINDS.join(' หรือ ')}`,
        [{ field: 'kind', reason: String(kind) }],
      );
    }
    if (!(LEAD_FILE_TYPES as readonly string[]).includes(file.mimetype)) {
      throw new AppError(
        'VALIDATION_FAILED',
        'แนบได้เฉพาะ PDF, Word, PowerPoint, Excel หรือรูปภาพ (JPEG, PNG)',
        [{ field: 'file', reason: file.mimetype || 'unknown' }],
      );
    }
    if (file.size > MAX_LEAD_FILE_BYTES) {
      throw new AppError('VALIDATION_FAILED', 'ไฟล์ใหญ่เกิน 20 MB', [
        { field: 'file', reason: 'too_large' },
      ]);
    }
    const lead = await this.requireLead(leadId, actor);

    const id = randomUUID();
    const fileName = safeFileName(file.originalname);
    const storageKey = `leads/${lead.id}/files/${id}/${fileName}`;
    const source = actor.isServiceAccount ? 'agent' : 'user';
    await this.storage.put(storageKey, file.buffer, {
      contentType: file.mimetype,
      size: file.size,
    });

    try {
      const created = await this.transactions.execute(async (prisma) => {
        const row = (await this.files.create(
          {
            data: {
              id,
              companyId: lead.companyId,
              leadId: lead.id,
              kind: fileKind,
              fileName,
              mimeType: file.mimetype,
              sizeBytes: file.size,
              storageKey,
              source,
              uploadedBy: auditActor(actor).actorId,
            },
            select: FILE_SELECT,
          },
          { prisma },
        )) as LeadFileRow;
        await this.audit.record(
          {
            eventType: 'crm.lead.file_added',
            companyId: lead.companyId,
            ...auditActor(actor),
            resourceType: 'lead',
            resourceId: lead.id,
            after: {
              fileId: id,
              kind: fileKind,
              fileName,
              sizeBytes: file.size,
            },
          },
          { prisma },
        );
        return row;
      });
      return this.view(created);
    } catch (error) {
      await this.discard(storageKey);
      throw error;
    }
  }

  async download(
    leadId: string,
    fileId: string,
    actor: Principal,
  ): Promise<{
    file: ReturnType<LeadFilesService['view']>;
    stream: Readable;
  }> {
    await this.requireLead(leadId, actor);
    const row = await this.requireFile(leadId, fileId);
    return {
      file: this.view(row),
      stream: await this.storage.get(row.storageKey),
    };
  }

  async remove(leadId: string, fileId: string, actor: Principal) {
    const lead = await this.requireLead(leadId, actor);
    const row = await this.requireFile(leadId, fileId);
    await this.transactions.execute(async (prisma) => {
      await this.files.update(
        {
          where: { id: row.id },
          data: {
            deletedAt: new Date(),
            deletedBy: auditActor(actor).actorId,
          },
        },
        { prisma },
      );
      await this.audit.record(
        {
          eventType: 'crm.lead.file_removed',
          companyId: lead.companyId,
          ...auditActor(actor),
          resourceType: 'lead',
          resourceId: lead.id,
          before: { fileId: row.id, kind: row.kind, fileName: row.fileName },
        },
        { prisma },
      );
    });
    // the row stays (no hard deletes); the bytes stay too, for the audit trail
  }

  /**
   * The newest proposal on a Lead, read whole — for the email. The caller has
   * already proved it may see the Lead. null = none uploaded.
   */
  async latestProposal(leadId: string): Promise<{
    id: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    content: Buffer;
  } | null> {
    const row = (await this.files.findFirst({
      where: { leadId, kind: 'proposal', deletedAt: null },
      orderBy: { uploadedAt: 'desc' },
      select: FILE_SELECT,
    })) as LeadFileRow | null;
    if (!row) return null;
    const stream = await this.storage.get(row.storageKey);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string),
      );
    }
    return {
      id: row.id,
      fileName: row.fileName,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      content: Buffer.concat(chunks),
    };
  }

  view(row: LeadFileRow) {
    return {
      id: row.id,
      lead_id: row.leadId,
      kind: row.kind,
      file_name: row.fileName,
      mime_type: row.mimeType,
      size_bytes: row.sizeBytes,
      source: row.source,
      uploaded_by: row.uploadedBy,
      uploaded_at: row.uploadedAt,
    };
  }

  private async requireLead(id: string, actor: Principal) {
    const found = (await this.leads.findFirst({
      where: { id, AND: [visibleLeadsWhere(salesAccessSubject(actor))] },
      select: { id: true, companyId: true },
    })) as { id: string; companyId: string } | null;
    // SCOPE-03: out of reach answers 404.
    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบ Lead ที่ระบุ');
    return found;
  }

  private async requireFile(leadId: string, fileId: string) {
    const found = (await this.files.findFirst({
      where: { id: fileId, leadId, deletedAt: null },
      select: FILE_SELECT,
    })) as LeadFileRow | null;
    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบไฟล์ที่ระบุ');
    return found;
  }

  private async discard(storageKey: string): Promise<void> {
    try {
      await this.storage.remove(storageKey);
    } catch (error) {
      this.logger.error(
        `ลบไฟล์ไม่สำเร็จ: ${storageKey}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
