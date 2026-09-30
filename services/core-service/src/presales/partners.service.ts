import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  AppError,
  AuditWriter,
  auditActor,
  OBJECT_STORAGE,
  Principal,
  PrismaTransactionService,
} from '@request-management/share';
import type { ObjectStorage } from '@request-management/share';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { CompanyRepository } from '../crm/product.repositories';
import { errorMessage } from '../crm/erp-sync-queue';
import { ERP_CLIENT } from '../erp/erp-client';
import type { ErpClient, ErpVendor } from '../erp/erp-client';
import { safeFileName } from '../requests/attachments.service';
import {
  PresalesPartnerFileRepository,
  PresalesPartnerRepository,
} from './solution.repositories';
import {
  cleanProfile,
  expiryCounts,
  expiryState,
  PARTNER_FILE_CATEGORIES,
  readBrands,
  readCertifications,
  readContacts,
  type PartnerFileCategory,
  type PartnerProfileInput,
} from './partner-rules';

export const MAX_PARTNER_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_PARTNER_FILES = 50;
/** SAP's supplier list is read live; this keeps a page of searches cheap. */
const VENDOR_CACHE_MS = 10 * 60 * 1000;
const LIST_LIMIT = 200;

interface UploadedFile {
  readonly originalname: string;
  readonly mimetype: string;
  readonly size: number;
  readonly buffer: Buffer;
}

interface PartnerRow {
  id: string;
  companyId: string;
  vendorCode: string;
  vendorNameSeen: string;
  summary: string;
  brands: unknown;
  certifications: unknown;
  contacts: unknown;
  updatedAt: Date;
  updatedBy: string | null;
}

const PARTNER_SELECT = {
  id: true,
  companyId: true,
  vendorCode: true,
  vendorNameSeen: true,
  summary: true,
  brands: true,
  certifications: true,
  contacts: true,
  updatedAt: true,
  updatedBy: true,
} as const;

const today = () => new Date().toISOString().slice(0, 10);

/**
 * CD-142 — ข้อมูลคู่ค้า (user decisions 30 ก.ย. 2569):
 *
 * - the partner list IS SAP's supplier list (BP `cSupplier`), read live
 *   through ErpClient — no second register. Name, tax id, payment terms and
 *   whether the supplier is blocked always come from SAP;
 * - what Connect the Dot adds is the technical profile keyed by the SAP
 *   code: brands and partner levels, engineers' certificates (both with
 *   expiry, flagged {@link EXPIRY_WARNING_DAYS} ahead), technical contacts,
 *   and reference documents on object storage;
 * - Pre-Sales manages it (`presales.solution.manage`), `presales.solution.read`
 *   sees it; the partner-quote form (CD-136) picks its vendor from this list.
 *
 * If SAP cannot be reached the list still shows the profiles already kept,
 * by the name last seen, flagged `sap_available: false`; a new profile can
 * only be started for a code SAP confirms.
 */
@Injectable()
export class PartnersService {
  private readonly logger = new Logger(PartnersService.name);
  private readonly cache = new Map<
    string,
    { at: number; vendors: ErpVendor[] }
  >();

  constructor(
    private readonly partners: PresalesPartnerRepository,
    private readonly files: PresalesPartnerFileRepository,
    private readonly companies: CompanyRepository,
    @Inject(ERP_CLIENT) private readonly erp: ErpClient,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  // --- reading ------------------------------------------------------------------

  /** SAP's suppliers with the profile summary of each; `q` searches code/name. */
  async list(actor: Principal, q?: string, activeOnly = false) {
    const companyId = actor.activeCompanyId;
    const [sap, profiles] = await Promise.all([
      this.vendors(companyId),
      this.partners.findMany({
        where: { companyId, deletedAt: null },
        select: PARTNER_SELECT,
      }) as Promise<PartnerRow[]>,
    ]);
    const byCode = new Map(profiles.map((row) => [row.vendorCode, row]));
    const now = today();
    const term = q?.trim().toLowerCase() ?? '';

    // SAP down: the kept profiles only, by the name last seen.
    const rows: {
      vendor: ErpVendor | null;
      profile: PartnerRow | undefined;
    }[] = sap
      ? sap.map((vendor) => ({ vendor, profile: byCode.get(vendor.code) }))
      : profiles.map((profile) => ({ vendor: null, profile }));
    const items = rows
      .map(({ vendor, profile }) => ({
        code: vendor?.code ?? profile?.vendorCode ?? '',
        name: vendor?.name ?? profile?.vendorNameSeen ?? '',
        taxId: vendor?.taxId ?? null,
        active: vendor?.active ?? null,
        has_profile: !!profile,
        brands: profile ? readBrands(profile.brands) : [],
        certification_count: profile
          ? readCertifications(profile.certifications).length
          : 0,
        expiry: profile
          ? expiryCounts(profile, now)
          : { expired: 0, expiring: 0 },
      }))
      .filter((row) => !activeOnly || row.active !== false)
      .filter(
        (row) =>
          !term ||
          row.code.toLowerCase().includes(term) ||
          row.name.toLowerCase().includes(term) ||
          row.brands.some((brand) => brand.brand.toLowerCase().includes(term)),
      )
      // Profiled partners first — they are the ones Pre-Sales works with.
      .sort(
        (a, b) =>
          Number(b.has_profile) - Number(a.has_profile) ||
          a.code.localeCompare(b.code),
      );
    return {
      sap_available: sap !== null,
      total: items.length,
      items: items.slice(0, LIST_LIMIT),
    };
  }

  /** One partner: SAP's commercial facts, the technical profile, its files. */
  async findOne(code: string, actor: Principal) {
    const companyId = actor.activeCompanyId;
    const [sap, profile] = await Promise.all([
      this.vendors(companyId),
      this.profileOf(companyId, code),
    ]);
    const vendor = sap?.find((row) => row.code === code) ?? null;
    // SCOPE-03: a code neither SAP nor we know answers 404.
    if (!vendor && !profile) {
      throw new AppError('NOT_FOUND', 'ไม่พบผู้ขายรหัสนี้ใน SAP');
    }
    const files = profile
      ? ((await this.files.findMany({
          where: { partnerId: profile.id, deletedAt: null },
          orderBy: { uploadedAt: 'asc' },
          select: {
            id: true,
            category: true,
            fileName: true,
            mimeType: true,
            sizeBytes: true,
            uploadedBy: true,
            uploadedAt: true,
          },
        })) as unknown[])
      : [];
    const now = today();
    return {
      code,
      sap_available: sap !== null,
      /** Null when SAP no longer lists the code, or cannot be reached. */
      vendor,
      name: vendor?.name ?? profile?.vendorNameSeen ?? code,
      can_manage: this.canManage(actor),
      profile: {
        exists: !!profile,
        summary: profile?.summary ?? '',
        brands: readBrands(profile?.brands).map((row) => ({
          ...row,
          expiry: expiryState(row.expiresOn, now),
        })),
        certifications: readCertifications(profile?.certifications).map(
          (row) => ({ ...row, expiry: expiryState(row.expiresOn, now) }),
        ),
        contacts: readContacts(profile?.contacts),
        updatedAt: profile?.updatedAt ?? null,
        updatedBy: profile?.updatedBy ?? null,
      },
      files,
    };
  }

  // --- writing ------------------------------------------------------------------

  /** Save the technical profile; the first save creates it. */
  async save(code: string, input: PartnerProfileInput, actor: Principal) {
    const companyId = actor.activeCompanyId;
    const cleaned = cleanProfile(input);
    if (!cleaned.ok) {
      throw new AppError(
        'VALIDATION_FAILED',
        'ข้อมูลคู่ค้าไม่ถูกต้อง',
        cleaned.problems,
      );
    }
    const existing = await this.profileOf(companyId, code);
    const vendor = await this.requireVendor(companyId, code, !existing);
    const data = {
      summary: cleaned.summary,
      brands: cleaned.brands as unknown as Prisma.InputJsonValue,
      certifications:
        cleaned.certifications as unknown as Prisma.InputJsonValue,
      contacts: cleaned.contacts as unknown as Prisma.InputJsonValue,
      vendorNameSeen: vendor?.name ?? existing?.vendorNameSeen ?? '',
    };

    await this.transactions.execute(async (prisma) => {
      const saved = existing
        ? ((await this.partners.update(
            {
              where: { id: existing.id },
              data: { ...data, updatedBy: actor.userId },
            },
            { prisma },
          )) as { id: string })
        : ((await this.partners.create(
            {
              data: {
                ...data,
                companyId,
                vendorCode: code,
                createdBy: actor.userId,
              },
            },
            { prisma },
          )) as { id: string });
      await this.audit.record(
        {
          eventType: existing
            ? 'presales.partner.updated'
            : 'presales.partner.created',
          companyId,
          ...auditActor(actor),
          resourceType: 'presales_partner',
          resourceId: saved.id,
          before: existing
            ? ({
                summary: existing.summary,
                brands: existing.brands,
                certifications: existing.certifications,
                contacts: existing.contacts,
              } as Prisma.InputJsonObject)
            : undefined,
          after: {
            vendorCode: code,
            summary: cleaned.summary,
            brands: data.brands,
            certifications: data.certifications,
            contacts: data.contacts,
          },
        },
        { prisma },
      );
    });
    return this.findOne(code, actor);
  }

  async uploadFile(
    code: string,
    category: string | undefined,
    file: UploadedFile | undefined,
    actor: Principal,
  ) {
    if (!file) {
      throw new AppError('VALIDATION_FAILED', 'กรุณาเลือกไฟล์', [
        { field: 'file', reason: 'required' },
      ]);
    }
    if (file.size > MAX_PARTNER_FILE_BYTES) {
      throw new AppError('VALIDATION_FAILED', 'ไฟล์ใหญ่เกิน 25 MB', [
        { field: 'file', reason: 'too_large' },
      ]);
    }
    const kind: PartnerFileCategory = PARTNER_FILE_CATEGORIES.includes(
      category as PartnerFileCategory,
    )
      ? (category as PartnerFileCategory)
      : 'other';
    const companyId = actor.activeCompanyId;
    const profile = await this.profileOf(companyId, code);
    if (!profile) {
      throw new AppError('CONFLICT', 'บันทึกข้อมูลคู่ค้าก่อน แล้วจึงแนบเอกสาร');
    }
    const count = await this.files.count({
      where: { partnerId: profile.id, deletedAt: null },
    });
    if (count >= MAX_PARTNER_FILES) {
      throw new AppError(
        'CONFLICT',
        `แนบได้ไม่เกิน ${MAX_PARTNER_FILES} ไฟล์ต่อคู่ค้า`,
      );
    }

    const fileName = safeFileName(file.originalname);
    const storageKey = `partners/${profile.id}/${randomUUID()}/${fileName}`;
    await this.storage.put(storageKey, file.buffer, {
      contentType: file.mimetype || 'application/octet-stream',
      size: file.size,
    });
    try {
      await this.transactions.execute(async (prisma) => {
        const created = (await this.files.create(
          {
            data: {
              partnerId: profile.id,
              companyId,
              category: kind,
              fileName,
              mimeType: file.mimetype || 'application/octet-stream',
              sizeBytes: file.size,
              storageKey,
              uploadedBy: actor.userId,
            },
          },
          { prisma },
        )) as { id: string };
        await this.audit.record(
          {
            eventType: 'presales.partner.file_uploaded',
            companyId,
            ...auditActor(actor),
            resourceType: 'presales_partner',
            resourceId: profile.id,
            after: {
              fileId: created.id,
              category: kind,
              fileName,
              sizeBytes: file.size,
            },
          },
          { prisma },
        );
      });
    } catch (error) {
      await this.storage
        .remove(storageKey)
        .catch((cleanup: unknown) =>
          this.logger.warn(
            `orphaned partner file ${storageKey}: ${String(cleanup)}`,
          ),
        );
      throw error;
    }
    return this.findOne(code, actor);
  }

  async downloadFile(
    code: string,
    fileId: string,
    actor: Principal,
  ): Promise<{ fileName: string; mimeType: string; stream: Readable }> {
    const file = await this.requireFile(code, fileId, actor);
    return {
      fileName: file.fileName,
      mimeType: file.mimeType,
      stream: await this.storage.get(file.storageKey),
    };
  }

  /** Soft delete — the stored object stays, like every other attachment. */
  async removeFile(code: string, fileId: string, actor: Principal) {
    const file = await this.requireFile(code, fileId, actor);
    await this.transactions.execute(async (prisma) => {
      await this.files.update(
        { where: { id: file.id }, data: { deletedAt: new Date() } },
        { prisma },
      );
      await this.audit.record(
        {
          eventType: 'presales.partner.file_removed',
          companyId: actor.activeCompanyId,
          ...auditActor(actor),
          resourceType: 'presales_partner',
          resourceId: file.partnerId,
          before: { fileId: file.id, fileName: file.fileName },
        },
        { prisma },
      );
    });
    return this.findOne(code, actor);
  }

  // --- helpers --------------------------------------------------------------------

  canManage(actor: Principal): boolean {
    return actor.permissions.includes('presales.solution.manage');
  }

  /** SAP's suppliers for the company, or null when SAP cannot be reached. */
  async vendors(companyId: string): Promise<ErpVendor[] | null> {
    const hit = this.cache.get(companyId);
    if (hit && Date.now() - hit.at < VENDOR_CACHE_MS) return hit.vendors;
    const company = (await this.companies.findFirst({
      where: { id: companyId },
      select: { code: true },
    })) as { code: string } | null;
    if (!company) return null;
    try {
      const vendors = await this.erp.listVendors({
        companyCode: company.code,
      });
      this.cache.set(companyId, { at: Date.now(), vendors });
      return vendors;
    } catch (error) {
      this.logger.warn(
        `SAP supplier list ${company.code} failed: ${errorMessage(error)}`,
      );
      return null;
    }
  }

  private async profileOf(companyId: string, code: string) {
    return (await this.partners.findFirst({
      where: { companyId, vendorCode: code, deletedAt: null },
      select: PARTNER_SELECT,
    })) as PartnerRow | null;
  }

  /**
   * The SAP supplier behind `code`. Starting a profile needs SAP to confirm
   * the code; editing an existing one goes on while SAP is down.
   */
  private async requireVendor(
    companyId: string,
    code: string,
    mustConfirm: boolean,
  ): Promise<ErpVendor | null> {
    const sap = await this.vendors(companyId);
    if (sap === null) {
      if (mustConfirm) {
        throw new AppError(
          'CONFLICT',
          'ตรวจรหัสผู้ขายกับ SAP ไม่ได้ตอนนี้ — ลองใหม่ภายหลัง',
        );
      }
      return null;
    }
    const vendor = sap.find((row) => row.code === code) ?? null;
    if (!vendor && mustConfirm) {
      throw new AppError('NOT_FOUND', 'ไม่พบผู้ขายรหัสนี้ใน SAP');
    }
    return vendor;
  }

  private async requireFile(code: string, fileId: string, actor: Principal) {
    const profile = await this.profileOf(actor.activeCompanyId, code);
    const file = profile
      ? ((await this.files.findFirst({
          where: { id: fileId, partnerId: profile.id, deletedAt: null },
          select: {
            id: true,
            partnerId: true,
            fileName: true,
            mimeType: true,
            storageKey: true,
          },
        })) as {
          id: string;
          partnerId: string;
          fileName: string;
          mimeType: string;
          storageKey: string;
        } | null)
      : null;
    if (!file) throw new AppError('NOT_FOUND', 'ไม่พบไฟล์ที่ระบุ');
    return file;
  }
}
