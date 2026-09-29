import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AppError,
  AuditWriter,
  auditActor,
  OBJECT_STORAGE,
  Principal,
  PrismaTransactionService,
  salesAccessSubject,
  visibleSalesWhere,
} from '@request-management/share';
import type { ObjectStorage } from '@request-management/share';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import {
  OpportunityActivityPhotoRepository,
  OpportunityActivityRepository,
  OpportunityRepository,
} from './sales.repositories';
import { safeFileName } from '../requests/attachments.service';

/** A phone photo is a few MB; this is generous without inviting videos. */
export const MAX_PHOTO_BYTES = 15 * 1024 * 1024;
/** Enough for a visit; a gallery is a different feature. */
export const MAX_PHOTOS_PER_ACTIVITY = 10;
/** HEIC/HEIF is what an iPhone camera saves by default. */
export const PHOTO_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
] as const;

interface UploadedPhoto {
  readonly originalname: string;
  readonly mimetype: string;
  readonly size: number;
  readonly buffer: Buffer;
}

export interface ActivityPhotoView {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  uploadedBy: string;
  uploadedAt: Date;
}

const PHOTO_SELECT = {
  id: true,
  fileName: true,
  mimeType: true,
  sizeBytes: true,
  uploadedBy: true,
  uploadedAt: true,
} as const;

/**
 * CD-75 — photos on a deal's activity, taken on the phone right after the
 * visit. Stored in object storage like request attachments: the bytes are
 * written first and the row second, so a row always has a file.
 *
 * Who may see a photo is who may see the deal (SCOPE-03: out of reach = 404).
 * Only the person who took it may remove it; removal is a soft delete that
 * also drops the object.
 */
@Injectable()
export class ActivityPhotosService {
  private readonly logger = new Logger(ActivityPhotosService.name);

  constructor(
    private readonly opportunities: OpportunityRepository,
    private readonly activities: OpportunityActivityRepository,
    private readonly photos: OpportunityActivityPhotoRepository,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  async upload(
    opportunityId: string,
    activityId: string,
    file: UploadedPhoto | undefined,
    actor: Principal,
  ): Promise<ActivityPhotoView> {
    if (!file) {
      throw new AppError('VALIDATION_FAILED', 'กรุณาเลือกรูป', [
        { field: 'file', reason: 'required' },
      ]);
    }
    if (!(PHOTO_TYPES as readonly string[]).includes(file.mimetype)) {
      throw new AppError(
        'VALIDATION_FAILED',
        'แนบได้เฉพาะรูปภาพ (JPEG, PNG, WebP, HEIC)',
        [{ field: 'file', reason: file.mimetype || 'unknown' }],
      );
    }
    if (file.size > MAX_PHOTO_BYTES) {
      throw new AppError('VALIDATION_FAILED', 'รูปใหญ่เกิน 15 MB', [
        { field: 'file', reason: 'too_large' },
      ]);
    }

    const deal = await this.requireDeal(opportunityId, actor);
    if (deal.stage === 'won' || deal.stage === 'lost') {
      throw new AppError('CONFLICT', 'โอกาสการขายนี้ปิดแล้ว — แนบรูปไม่ได้');
    }
    await this.requireActivity(opportunityId, activityId);

    const count = await this.photos.count({
      where: { activityId, deletedAt: null },
    });
    if (count >= MAX_PHOTOS_PER_ACTIVITY) {
      throw new AppError(
        'VALIDATION_FAILED',
        `แนบรูปได้ไม่เกิน ${MAX_PHOTOS_PER_ACTIVITY} รูปต่อกิจกรรม`,
        [{ field: 'file', reason: 'too_many' }],
      );
    }

    const id = randomUUID();
    const fileName = safeFileName(file.originalname);
    const storageKey = `opportunities/${opportunityId}/activities/${activityId}/${id}/${fileName}`;
    await this.storage.put(storageKey, file.buffer, {
      contentType: file.mimetype,
      size: file.size,
    });

    try {
      return await this.transactions.execute(async (prisma) => {
        const created = (await this.photos.create(
          {
            data: {
              id,
              companyId: deal.companyId,
              activityId,
              fileName,
              mimeType: file.mimetype,
              sizeBytes: file.size,
              storageKey,
              uploadedBy: actor.userId,
            },
            select: PHOTO_SELECT,
          },
          { prisma },
        )) as ActivityPhotoView;

        await this.audit.record(
          {
            eventType: 'crm.opportunity.activity_photo_added',
            companyId: deal.companyId,
            ...auditActor(actor),
            resourceType: 'opportunity',
            resourceId: opportunityId,
            after: { activityId, photoId: id, fileName, sizeBytes: file.size },
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

  async download(
    opportunityId: string,
    activityId: string,
    photoId: string,
    actor: Principal,
  ): Promise<{ photo: ActivityPhotoView; stream: Readable }> {
    await this.requireDeal(opportunityId, actor);
    const photo = await this.requirePhoto(opportunityId, activityId, photoId);
    return {
      photo,
      stream: await this.storage.get(photo.storageKey),
    };
  }

  async remove(
    opportunityId: string,
    activityId: string,
    photoId: string,
    actor: Principal,
  ): Promise<void> {
    const deal = await this.requireDeal(opportunityId, actor);
    const photo = await this.requirePhoto(opportunityId, activityId, photoId);
    if (photo.uploadedBy !== actor.userId) {
      throw new AppError('FORBIDDEN', 'ลบได้เฉพาะรูปที่คุณแนบเอง');
    }

    await this.transactions.execute(async (prisma) => {
      await this.photos.update(
        { where: { id: photoId }, data: { deletedAt: new Date() } },
        { prisma },
      );
      await this.audit.record(
        {
          eventType: 'crm.opportunity.activity_photo_removed',
          companyId: deal.companyId,
          ...auditActor(actor),
          resourceType: 'opportunity',
          resourceId: opportunityId,
          before: { activityId, photoId, fileName: photo.fileName },
        },
        { prisma },
      );
    });
    await this.discard(photo.storageKey);
  }

  // --- helpers -------------------------------------------------------------

  private async requireDeal(id: string, actor: Principal) {
    const found = (await this.opportunities.findFirst({
      where: { id, AND: [visibleSalesWhere(salesAccessSubject(actor))] },
      select: { id: true, companyId: true, stage: true },
    })) as { id: string; companyId: string; stage: string } | null;
    // SCOPE-03: out of reach answers 404.
    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบโอกาสการขายที่ระบุ');
    return found;
  }

  private async requireActivity(opportunityId: string, activityId: string) {
    const found = await this.activities.findFirst({
      where: { id: activityId, opportunityId },
      select: { id: true },
    });
    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบกิจกรรมที่ระบุ');
  }

  private async requirePhoto(
    opportunityId: string,
    activityId: string,
    photoId: string,
  ) {
    const found = (await this.photos.findFirst({
      where: {
        id: photoId,
        activityId,
        deletedAt: null,
        activity: { opportunityId },
      },
      select: { ...PHOTO_SELECT, storageKey: true },
    })) as (ActivityPhotoView & { storageKey: string }) | null;
    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบรูปที่ระบุ');
    return found;
  }

  private async discard(storageKey: string): Promise<void> {
    try {
      await this.storage.remove(storageKey);
    } catch (error) {
      this.logger.error(
        `ลบไฟล์รูปไม่สำเร็จ: ${storageKey}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
