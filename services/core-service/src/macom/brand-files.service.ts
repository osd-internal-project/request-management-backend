import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Inject, Injectable } from '@nestjs/common';
import {
  AppError,
  AuditWriter,
  auditActor,
  hasPermission,
  OBJECT_STORAGE,
  PrismaTransactionService,
} from '@request-management/share';
import type { ObjectStorage, Principal } from '@request-management/share';
import { safeFileName } from '../requests/attachments.service';
import { fileProblems, mayOpenVersion, nextVersionNo } from './brand-rules';
import { BrandService, type VersionRow } from './brand.service';
import { CreateBrandAssetDto } from './macom.dto';
import { BrandAssetVersionRepository } from './macom.repositories';

type Upload =
  | { originalname: string; mimetype: string; size: number; buffer: Buffer }
  | undefined;

/**
 * CD-273 — the brand library's files on object storage (the HTTP half:
 * storage is only wired there). Every upload is a version that waits for
 * approval; files are never deleted — an old version is history.
 */
@Injectable()
export class BrandFilesService {
  constructor(
    private readonly brand: BrandService,
    private readonly versions: BrandAssetVersionRepository,
    private readonly transactions: PrismaTransactionService,
    private readonly audit: AuditWriter,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  /** A new asset with its first version (waiting for approval). */
  async create(actor: Principal, dto: CreateBrandAssetDto, file: Upload) {
    const typeCode = await this.brand.approvalType(actor.activeCompanyId);
    const upload = this.check(file);
    const assetId = randomUUID();
    const stored = await this.store(assetId, upload);
    const versionId = randomUUID();
    try {
      await this.transactions.execute(async (prisma) => {
        await prisma.brandAsset.create({
          data: {
            id: assetId,
            companyId: actor.activeCompanyId,
            category: dto.category,
            name: dto.name.trim(),
            description: dto.description?.trim() || null,
            tags: [
              ...new Set(
                (dto.tags ?? '')
                  .split(',')
                  .map((tag) => tag.trim())
                  .filter(Boolean),
              ),
            ].slice(0, 20),
            createdBy: actor.userId,
            updatedBy: actor.userId,
          },
        });
        await prisma.brandAssetVersion.create({
          data: {
            id: versionId,
            companyId: actor.activeCompanyId,
            assetId,
            versionNo: 1,
            ...stored,
            note: dto.note?.trim() || null,
            uploadedBy: actor.userId,
          },
        });
        await this.audit.record(
          {
            eventType: 'macom.brand.created',
            companyId: actor.activeCompanyId,
            ...auditActor(actor),
            resourceType: 'brand_asset',
            resourceId: assetId,
            after: { name: dto.name, category: dto.category },
          },
          { prisma },
        );
      });
    } catch (error) {
      await this.storage.remove(stored.storageKey).catch(() => undefined);
      throw error;
    }
    await this.brand.requestApproval(
      actor,
      {
        id: assetId,
        companyId: actor.activeCompanyId,
        name: dto.name.trim(),
        category: dto.category,
      },
      {
        id: versionId,
        versionNo: 1,
        fileName: stored.fileName,
        note: dto.note?.trim() || null,
      },
      typeCode,
    );
    return this.brand.one(actor, assetId);
  }

  /** A new version of an asset (waiting for approval). */
  async addVersion(
    actor: Principal,
    assetId: string,
    note: string | undefined,
    file: Upload,
  ) {
    const asset = await this.brand.requireAsset(actor, assetId, true);
    if (asset.retiredAt) {
      throw new AppError('CONFLICT', 'ไฟล์นี้เลิกใช้แล้ว — เปิดใช้ใหม่ก่อน');
    }
    const typeCode = await this.brand.approvalType(asset.companyId);
    const upload = this.check(file);
    const existing = (await this.versions.findMany({
      where: { assetId },
      select: { versionNo: true, status: true },
    })) as { versionNo: number; status: string }[];
    if (existing.some((row) => row.status === 'pending')) {
      throw new AppError(
        'CONFLICT',
        'มีฉบับที่รออนุมัติอยู่แล้ว — รอผล หรือถอนฉบับนั้นก่อน',
      );
    }
    const versionNo = nextVersionNo(existing.map((row) => row.versionNo));
    const stored = await this.store(assetId, upload);
    let created: { id: string };
    try {
      created = (await this.versions.create({
        data: {
          companyId: asset.companyId,
          assetId,
          versionNo,
          ...stored,
          note: note?.trim() || null,
          uploadedBy: actor.userId,
        },
        select: { id: true },
      })) as { id: string };
    } catch (error) {
      await this.storage.remove(stored.storageKey).catch(() => undefined);
      throw error;
    }
    await this.brand.requestApproval(
      actor,
      asset,
      {
        id: created.id,
        versionNo,
        fileName: stored.fileName,
        note: note?.trim() || null,
      },
      typeCode,
    );
    return this.brand.one(actor, assetId);
  }

  /** The current version for anyone; any version for MACOM. */
  async file(
    actor: Principal,
    assetId: string,
    versionId?: string,
  ): Promise<{ stream: Readable; fileName: string; mimeType: string }> {
    const manager = hasPermission(actor, 'crm.campaign.manage');
    const asset = await this.brand.requireAsset(actor, assetId, manager);
    const wanted = versionId ?? asset.currentVersionId;
    if (
      !wanted ||
      !mayOpenVersion({
        versionId: wanted,
        currentVersionId: asset.currentVersionId,
        manager,
      })
    ) {
      throw new AppError('NOT_FOUND', 'ไม่พบไฟล์ฉบับนี้');
    }
    const version = (await this.versions.findFirst({
      where: { id: wanted, assetId },
    })) as VersionRow | null;
    if (!version) throw new AppError('NOT_FOUND', 'ไม่พบไฟล์ฉบับนี้');
    return {
      stream: await this.storage.get(version.storageKey),
      fileName: version.fileName,
      mimeType: version.mimeType,
    };
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

  private async store(
    assetId: string,
    file: NonNullable<Upload>,
  ): Promise<{
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    storageKey: string;
  }> {
    const fileName = safeFileName(file.originalname);
    const storageKey = `brand/${assetId}/${randomUUID()}/${fileName}`;
    await this.storage.put(storageKey, file.buffer, {
      contentType: file.mimetype,
      size: file.size,
    });
    return {
      fileName,
      mimeType: file.mimetype,
      sizeBytes: file.size,
      storageKey,
    };
  }
}
