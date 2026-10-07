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
import { EVIDENCE_TYPES, MAX_EVIDENCE_BYTES } from '../pm/milestones.service';
import { safeFileName } from '../requests/attachments.service';
import { CampaignSpendRepository } from '../crm/sales.repositories';
import { CampaignPlanService } from './campaign-plan.service';

/**
 * CD-268 — the receipt behind a campaign spend (PDF or image, one per spend;
 * a new upload replaces it). Lives in the HTTP half: object storage is only
 * wired there.
 */
@Injectable()
export class CampaignReceiptsService {
  constructor(
    private readonly plans: CampaignPlanService,
    private readonly spends: CampaignSpendRepository,
    private readonly audit: AuditWriter,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  async attach(
    actor: Principal,
    spendId: string,
    file:
      | { originalname: string; mimetype: string; size: number; buffer: Buffer }
      | undefined,
  ) {
    const spend = await this.plans.requireSpend(actor, spendId);
    if (spend.voidedAt) {
      throw new AppError('CONFLICT', 'รายการนี้ถูกยกเลิกแล้ว');
    }
    if (!file) {
      throw new AppError('VALIDATION_FAILED', 'แนบไฟล์ใบเสร็จ', [
        { field: 'file', reason: 'required' },
      ]);
    }
    if (!(EVIDENCE_TYPES as readonly string[]).includes(file.mimetype)) {
      throw new AppError(
        'VALIDATION_FAILED',
        'ใบเสร็จต้องเป็น PDF หรือรูปภาพ',
        [{ field: 'file', reason: file.mimetype }],
      );
    }
    if (file.size > MAX_EVIDENCE_BYTES) {
      throw new AppError('VALIDATION_FAILED', 'ไฟล์ใหญ่เกิน 25 MB', [
        { field: 'file', reason: 'too_large' },
      ]);
    }
    const name = safeFileName(file.originalname);
    const key = `campaigns/${spend.campaignId}/spends/${spendId}/${randomUUID()}/${name}`;
    await this.storage.put(key, file.buffer, {
      contentType: file.mimetype,
      size: file.size,
    });
    try {
      await this.spends.update({
        where: { id: spendId },
        data: {
          receiptKey: key,
          receiptName: name,
          receiptType: file.mimetype,
        },
      });
    } catch (error) {
      await this.storage.remove(key).catch(() => undefined);
      throw error;
    }
    if (spend.receiptKey) {
      await this.storage.remove(spend.receiptKey).catch(() => undefined);
    }
    await this.audit.record({
      eventType: 'macom.campaign.receipt_attached',
      companyId: spend.companyId,
      ...auditActor(actor),
      resourceType: 'campaign',
      resourceId: spend.campaignId,
      after: { spendId, fileName: name },
    });
    return this.plans.plan(actor, spend.campaignId);
  }

  async file(
    actor: Principal,
    spendId: string,
  ): Promise<{ stream: Readable; fileName: string; mimeType: string }> {
    const spend = await this.plans.requireSpend(actor, spendId);
    if (!spend.receiptKey) {
      throw new AppError('NOT_FOUND', 'รายการนี้ยังไม่มีใบเสร็จ');
    }
    return {
      stream: await this.storage.get(spend.receiptKey),
      fileName: spend.receiptName ?? 'receipt',
      mimeType: spend.receiptType ?? 'application/octet-stream',
    };
  }
}
