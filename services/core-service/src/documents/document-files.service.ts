import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Inject, Injectable } from '@nestjs/common';
import {
  AppError,
  AuditWriter,
  auditActor,
  OBJECT_STORAGE,
  PrismaTransactionService,
} from '@request-management/share';
import type { ObjectStorage, Principal } from '@request-management/share';
import { safeFileName } from '../requests/attachments.service';
import {
  type DocumentKind,
  fileProblems,
  issueDateFor,
} from './document-rules';
import { CreateDocumentDto } from './documents.dto';
import { DocumentsService } from './documents.service';

type Upload =
  | { originalname: string; mimetype: string; size: number; buffer: Buffer }
  | undefined;

/**
 * Company documents — the files. Provided where storage is: core-service's
 * HTTP half, and external-service's document module (the one place that
 * port reads bytes, so a machine can download what settings uploaded).
 */
@Injectable()
export class DocumentFilesService {
  constructor(
    private readonly documents: DocumentsService,
    private readonly transactions: PrismaTransactionService,
    private readonly audit: AuditWriter,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  async upload(actor: Principal, dto: CreateDocumentDto, file: Upload) {
    const issue = issueDateFor(dto.kind as DocumentKind, dto.issue_date);
    if (!issue.ok) {
      throw new AppError('VALIDATION_FAILED', issue.reason, [
        { field: 'issue_date', reason: issue.reason },
      ]);
    }
    const upload = this.check(file);
    const id = randomUUID();
    const fileName = safeFileName(upload.originalname);
    const storageKey = `company-documents/${actor.activeCompanyId}/${id}/${randomUUID()}/${fileName}`;
    await this.storage.put(storageKey, upload.buffer, {
      contentType: upload.mimetype,
      size: upload.size,
    });
    try {
      await this.transactions.execute(async (prisma) => {
        await prisma.companyDocument.create({
          data: {
            id,
            companyId: actor.activeCompanyId,
            kind: dto.kind,
            title: dto.title.trim(),
            description: dto.description?.trim() || null,
            issueDate: issue.date,
            fileName,
            mimeType: upload.mimetype,
            sizeBytes: upload.size,
            storageKey,
            uploadedBy: actor.userId,
          },
        });
        await this.audit.record(
          {
            eventType: 'document.uploaded',
            companyId: actor.activeCompanyId,
            ...auditActor(actor),
            resourceType: 'company_document',
            resourceId: id,
            after: {
              kind: dto.kind,
              title: dto.title,
              issue_date: dto.issue_date ?? null,
              file_name: fileName,
            },
          },
          { prisma },
        );
      });
    } catch (error) {
      await this.storage.remove(storageKey).catch(() => undefined);
      throw error;
    }
    return this.documents.one(actor.activeCompanyId, id, true);
  }

  /**
   * The file. The settings screen opens archived ones too; the External API
   * does not, and its downloads are audited — who took which document.
   */
  async file(
    actor: Principal,
    id: string,
    via: 'screen' | 'external',
  ): Promise<{ stream: Readable; fileName: string; mimeType: string }> {
    const row = await this.documents.require(
      actor.activeCompanyId,
      id,
      via === 'screen',
    );
    const stream = await this.storage.get(row.storageKey);
    if (via === 'external') {
      await this.audit.record({
        eventType: 'document.downloaded',
        companyId: actor.activeCompanyId,
        ...auditActor(actor),
        resourceType: 'company_document',
        resourceId: id,
        after: { file_name: row.fileName },
      });
    }
    return { stream, fileName: row.fileName, mimeType: row.mimeType };
  }

  private check(file: Upload) {
    if (!file) {
      throw new AppError('VALIDATION_FAILED', 'แนบไฟล์', [
        { field: 'file', reason: 'required' },
      ]);
    }
    const problems = fileProblems(file);
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'file', reason })),
      );
    }
    return file;
  }
}
