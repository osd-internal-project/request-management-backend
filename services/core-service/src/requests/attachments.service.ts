import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AppError,
  AuditWriter,
  auditActor,
  OBJECT_STORAGE,
  PrismaTransactionService,
} from '@request-management/share';
import type { ObjectStorage, Principal } from '@request-management/share';
import type { RequestAttachment } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { AttachmentRepository } from './attachment.repository';
import { RequestsService } from './requests.service';
import { assertKnownDocCode } from './submit-rules';

/** Rows written before file storage existed carry this prefix and no bytes. */
const PENDING_PREFIX = 'pending://';

export interface UploadedFile {
  readonly originalname: string;
  readonly mimetype: string;
  readonly size: number;
  readonly buffer: Buffer;
}

export interface AttachmentDownload {
  readonly attachment: RequestAttachment;
  readonly stream: Readable;
}

/** REQ-03 — the bytes behind a request's documents, kept in object storage. */
@Injectable()
export class AttachmentsService {
  private readonly logger = new Logger(AttachmentsService.name);

  constructor(
    private readonly requests: RequestsService,
    private readonly attachments: AttachmentRepository,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  /**
   * Stores the file, then records it. The row is written only after the bytes
   * are safe, so a row always has a file; a failed write removes the object.
   */
  async upload(
    id: string,
    file: UploadedFile | undefined,
    docCode: string | undefined,
    actor: Principal,
  ): Promise<RequestAttachment> {
    if (!file) {
      throw new AppError('VALIDATION_FAILED', 'กรุณาเลือกไฟล์', [
        { field: 'file', reason: 'required' },
      ]);
    }

    const found = await this.requests.requireEditableOwn(
      id,
      actor,
      'แนบเอกสาร',
    );
    assertKnownDocCode(await this.requests.attachableDocs(found), docCode);

    const attachmentId = randomUUID();
    const fileName = safeFileName(file.originalname);
    const mimeType = file.mimetype || 'application/octet-stream';
    const storageKey = `requests/${found.id}/${attachmentId}/${fileName}`;

    await this.storage.put(storageKey, file.buffer, {
      contentType: mimeType,
      size: file.size,
    });

    try {
      return await this.transactions.execute(async (prisma) => {
        const created = await this.attachments.create(
          {
            data: {
              id: attachmentId,
              requestId: found.id,
              docCode: docCode ?? null,
              fileName,
              mimeType,
              sizeBytes: file.size,
              storageKey,
              uploadedById: actor.userId,
            },
          },
          { prisma },
        );

        await this.audit.record(
          {
            eventType: 'request.attachment.added',
            companyId: found.companyId,
            ...auditActor(actor),
            resourceType: 'request_attachment',
            resourceId: created.id,
            after: {
              requestId: found.id,
              docCode: docCode ?? null,
              fileName,
              sizeBytes: file.size,
            },
          },
          { prisma },
        );

        return created;
      });
    } catch (error) {
      await this.discard(storageKey);
      throw error;
    }
  }

  /** Readable by anyone who may open the request; 404 otherwise (SCOPE-03). */
  async download(
    id: string,
    attachmentId: string,
    actor: Principal,
  ): Promise<AttachmentDownload> {
    const request = await this.requests.findOne(id, actor);
    const attachment = request.attachments.find(
      (row) => row.id === attachmentId && !row.deletedAt,
    );

    if (!attachment) {
      throw new AppError('NOT_FOUND', 'ไม่พบเอกสารแนบที่ระบุ');
    }

    if (attachment.storageKey.startsWith(PENDING_PREFIX)) {
      throw new AppError(
        'ATTACHMENT_NO_FILE',
        'เอกสารนี้บันทึกไว้ก่อนเปิดใช้การเก็บไฟล์ จึงไม่มีไฟล์ให้ดาวน์โหลด',
      );
    }

    return {
      attachment,
      stream: await this.storage.get(attachment.storageKey),
    };
  }

  private async discard(storageKey: string): Promise<void> {
    try {
      await this.storage.remove(storageKey);
    } catch (error) {
      this.logger.error(
        `ลบไฟล์ที่ไม่มีแถวอ้างอิงไม่สำเร็จ: ${storageKey}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}

/** Keeps Thai and other letters; drops path separators and control characters. */
export function safeFileName(name: string): string {
  const cleaned = name
    .replace(/[\\/]/g, '_')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  return (cleaned || 'file').slice(0, 255);
}
