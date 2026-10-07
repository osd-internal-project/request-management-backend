import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Inject, Injectable } from '@nestjs/common';
import {
  AppError,
  AuditWriter,
  auditActor,
  OBJECT_STORAGE,
} from '@request-management/share';
import type { ObjectStorage, Principal } from '@request-management/share';
import { safeFileName } from '../requests/attachments.service';
import { editable } from './content-rules';
import { ContentService } from './content.service';
import { ContentFileRepository } from './macom.repositories';

/** What a post may carry: pictures, short video, PDF. */
export const CONTENT_MEDIA_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'video/mp4',
  'application/pdf',
] as const;
export const MAX_CONTENT_MEDIA_BYTES = 100 * 1024 * 1024;
const MAX_FILES_PER_ITEM = 20;

/**
 * CD-271 — a post's media on object storage (the HTTP half: storage is only
 * wired there). Removing a file hides it from the post; the object stays,
 * since a copied post may point at the same one.
 */
@Injectable()
export class ContentFilesService {
  constructor(
    private readonly content: ContentService,
    private readonly files: ContentFileRepository,
    private readonly audit: AuditWriter,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  async attach(
    actor: Principal,
    contentId: string,
    file:
      | { originalname: string; mimetype: string; size: number; buffer: Buffer }
      | undefined,
  ) {
    const item = await this.content.require(actor, contentId);
    if (!editable(item.status)) {
      throw new AppError(
        'CONFLICT',
        'คอนเทนต์ที่เผยแพร่หรือยกเลิกแล้วแก้ไม่ได้',
      );
    }
    if (!file) {
      throw new AppError('VALIDATION_FAILED', 'แนบไฟล์', [
        { field: 'file', reason: 'required' },
      ]);
    }
    if (!(CONTENT_MEDIA_TYPES as readonly string[]).includes(file.mimetype)) {
      throw new AppError(
        'VALIDATION_FAILED',
        'รองรับรูป (JPG/PNG/GIF/WebP) วิดีโอ MP4 และ PDF',
        [{ field: 'file', reason: file.mimetype }],
      );
    }
    if (file.size > MAX_CONTENT_MEDIA_BYTES) {
      throw new AppError('VALIDATION_FAILED', 'ไฟล์ใหญ่เกิน 100 MB', [
        { field: 'file', reason: 'too_large' },
      ]);
    }
    const count = await this.files.count({
      where: { contentId, removedAt: null },
    });
    if (count >= MAX_FILES_PER_ITEM) {
      throw new AppError(
        'VALIDATION_FAILED',
        `แนบได้ไม่เกิน ${MAX_FILES_PER_ITEM} ไฟล์ต่อคอนเทนต์`,
      );
    }
    const name = safeFileName(file.originalname);
    const key = `content/${contentId}/${randomUUID()}/${name}`;
    await this.storage.put(key, file.buffer, {
      contentType: file.mimetype,
      size: file.size,
    });
    try {
      await this.files.create({
        data: {
          companyId: item.companyId,
          contentId,
          fileName: name,
          mimeType: file.mimetype,
          sizeBytes: file.size,
          storageKey: key,
          uploadedBy: actor.userId,
        },
      });
    } catch (error) {
      await this.storage.remove(key).catch(() => undefined);
      throw error;
    }
    await this.audit.record({
      eventType: 'macom.content.file_added',
      companyId: item.companyId,
      ...auditActor(actor),
      resourceType: 'content_item',
      resourceId: contentId,
      after: { fileName: name },
    });
    return this.content.one(actor, contentId);
  }

  async remove(actor: Principal, contentId: string, fileId: string) {
    const item = await this.content.require(actor, contentId);
    if (!editable(item.status)) {
      throw new AppError(
        'CONFLICT',
        'คอนเทนต์ที่เผยแพร่หรือยกเลิกแล้วแก้ไม่ได้',
      );
    }
    const found = await this.files.findFirst({
      where: { id: fileId, contentId, removedAt: null },
      select: { id: true, fileName: true },
    });
    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบไฟล์นี้');
    await this.files.update({
      where: { id: fileId },
      data: { removedAt: new Date() },
    });
    await this.audit.record({
      eventType: 'macom.content.file_removed',
      companyId: item.companyId,
      ...auditActor(actor),
      resourceType: 'content_item',
      resourceId: contentId,
      before: { fileId },
    });
    return this.content.one(actor, contentId);
  }

  async file(
    actor: Principal,
    contentId: string,
    fileId: string,
  ): Promise<{ stream: Readable; fileName: string; mimeType: string }> {
    await this.content.require(actor, contentId);
    const found = (await this.files.findFirst({
      where: { id: fileId, contentId, removedAt: null },
    })) as { storageKey: string; fileName: string; mimeType: string } | null;
    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบไฟล์นี้');
    return {
      stream: await this.storage.get(found.storageKey),
      fileName: found.fileName,
      mimeType: found.mimeType,
    };
  }
}
