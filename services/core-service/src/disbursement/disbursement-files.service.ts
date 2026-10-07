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
import { safeFileName } from '../requests/attachments.service';
import { DisbursementFileRepository } from './disbursement.repositories';
import { DisbursementsService } from './disbursements.service';

/** Screen 6 splits the receipts: tax invoice, receipt voucher, travel / lodging slip. */
export const DISBURSEMENT_FILE_KINDS = [
  'PAYMENT_SLIP',
  'TAX_INVOICE',
  'RECEIPT_VOUCHER',
  'TRAVEL_SLIP',
  'RECEIPT',
  'REFUND_PROOF',
  'OTHER',
] as const;
export type DisbursementFileKind = (typeof DISBURSEMENT_FILE_KINDS)[number];

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const FILE_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];
const PAY = 'disbursement.pay';

interface UploadedFile {
  readonly originalname: string;
  readonly mimetype: string;
  readonly size: number;
  readonly buffer: Buffer;
}

/**
 * การเบิก — evidence on the work screen: accounting's payment slip, the
 * requester's receipts and refund proof. Screen routes only: external-service
 * has no object storage (AGENTS.md, e-sign).
 */
@Injectable()
export class DisbursementFilesService {
  constructor(
    private readonly disbursements: DisbursementsService,
    private readonly files: DisbursementFileRepository,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  async upload(
    actor: Principal,
    docNo: string,
    kind: string,
    file: UploadedFile | undefined,
  ) {
    const row = await this.disbursements.rowFor(actor, docNo);
    this.assertMayAttach(actor, row.requesterId, kind);
    const problems = [
      ...(!file ? ['ต้องแนบไฟล์'] : []),
      ...(file && !FILE_TYPES.includes(file.mimetype)
        ? ['แนบได้เฉพาะ PDF, JPG หรือ PNG']
        : []),
      ...(file && file.size > MAX_FILE_BYTES ? ['ไฟล์ใหญ่เกิน 10 MB'] : []),
    ];
    if (problems.length || !file) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'file', reason })),
      );
    }

    const id = randomUUID();
    const name = safeFileName(file.originalname);
    const key = `disbursements/${row.id}/${id}/${name}`;
    await this.storage.put(key, file.buffer, {
      contentType: file.mimetype,
      size: file.size,
    });
    try {
      await this.transactions.execute(async (prisma) => {
        await prisma.disbursementFile.create({
          data: {
            id,
            disbursementId: row.id,
            kind,
            fileName: name,
            mimeType: file.mimetype,
            sizeBytes: file.size,
            storageKey: key,
            uploadedBy: actor.userId,
          },
        });
        await this.audit.record(
          {
            eventType: 'disbursement.file_attached',
            companyId: row.companyId,
            ...auditActor(actor),
            resourceType: 'disbursement',
            resourceId: row.id,
            after: { fileId: id, kind, fileName: name },
          },
          { prisma },
        );
      });
    } catch (error) {
      await this.storage.remove(key).catch(() => undefined);
      throw error;
    }
    return this.disbursements.detail(actor, docNo);
  }

  async download(
    actor: Principal,
    docNo: string,
    fileId: string,
  ): Promise<{ stream: Readable; fileName: string; mimeType: string }> {
    const row = await this.disbursements.rowFor(actor, docNo);
    const file = await this.require(row.id, fileId);
    return {
      stream: await this.storage.get(file.storageKey),
      fileName: file.fileName,
      mimeType: file.mimeType,
    };
  }

  /** Soft delete; the stored object stays, like every evidence in this system. */
  async remove(actor: Principal, docNo: string, fileId: string) {
    const row = await this.disbursements.rowFor(actor, docNo);
    if (row.status === 'CLOSED') {
      throw new AppError('CONFLICT', 'ใบเบิกปิดแล้ว ลบหลักฐานไม่ได้');
    }
    const file = await this.require(row.id, fileId);
    if (file.uploadedBy !== actor.userId && !actor.permissions.includes(PAY)) {
      throw new AppError('FORBIDDEN', 'ลบได้เฉพาะไฟล์ที่ตัวเองแนบ');
    }
    await this.transactions.execute(async (prisma) => {
      await prisma.disbursementFile.update({
        where: { id: file.id },
        data: { deletedAt: new Date(), deletedBy: actor.userId },
      });
      await this.audit.record(
        {
          eventType: 'disbursement.file_removed',
          companyId: row.companyId,
          ...auditActor(actor),
          resourceType: 'disbursement',
          resourceId: row.id,
          before: { fileId: file.id, fileName: file.fileName },
        },
        { prisma },
      );
    });
    return this.disbursements.detail(actor, docNo);
  }

  /** The slip is accounting's; receipts and refund proof are the requester's. */
  private assertMayAttach(actor: Principal, requesterId: string, kind: string) {
    if (!(DISBURSEMENT_FILE_KINDS as readonly string[]).includes(kind)) {
      throw new AppError('VALIDATION_FAILED', 'ชนิดไฟล์ไม่ถูกต้อง', [
        { field: 'kind', reason: kind },
      ]);
    }
    const mayPay = actor.permissions.includes(PAY);
    const isRequester = actor.userId === requesterId;
    const allowed =
      kind === 'PAYMENT_SLIP' ? mayPay : isRequester || mayPay;
    if (!allowed) {
      throw new AppError('FORBIDDEN', 'ไม่มีสิทธิ์แนบไฟล์ชนิดนี้');
    }
  }

  private async require(disbursementId: string, fileId: string) {
    // BaseRepository's return type drops Prisma's `select` generics.
    const file = (await this.files.findFirst({
      where: { id: fileId, disbursementId, deletedAt: null },
    })) as {
      id: string;
      storageKey: string;
      fileName: string;
      mimeType: string;
      uploadedBy: string;
    } | null;
    if (!file) throw new AppError('NOT_FOUND', 'ไม่พบไฟล์');
    return file;
  }
}
