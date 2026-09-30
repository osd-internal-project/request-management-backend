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
import { OpportunityRepository } from '../crm/sales.repositories';
import { CrmConfigRepository } from '../crm/segment.repositories';
import { safeFileName } from '../requests/attachments.service';
import { RequestsService } from '../requests/requests.service';
import { RequestRepository } from '../requests/request.repository';
import {
  SolutionPartnerQuoteRepository,
  SolutionVersionRepository,
} from './solution.repositories';
import { SolutionsService } from './solutions.service';
import {
  cleanLabor,
  cleanQuoteLines,
  readLaborRates,
  vendorQuoteItems,
} from './solution-rules';
import type {
  SaveLaborDto,
  SavePartnerQuoteDto,
  VendorQuoteRequestDto,
} from './dto/solution.dto';

export const MAX_QUOTE_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_QUOTES_PER_VERSION = 100;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const day = (value: string) => new Date(`${value}T00:00:00Z`);

interface UploadedFile {
  readonly originalname: string;
  readonly mimetype: string;
  readonly size: number;
  readonly buffer: Buffer;
}

interface VersionRow {
  id: string;
  versionNo: number;
  status: string;
  boq: unknown;
}

/**
 * CD-136 — ประมาณต้นทุน (user decisions 30 ก.ย. 2569):
 *
 * - the estimate belongs to a Solution version: each BOQ line is costed by
 *   the newest partner quote for it, else its reference cost; labour is
 *   mandays × the rate for a role from the settings' rate table (copied in,
 *   until HR — CD-17 — supplies real rates). It stays editable on a draft
 *   or locked version — costing usually follows the design — and freezes
 *   when the version is superseded;
 * - partner prices come through the "ขอราคาจากคู่ค้า" request type
 *   (Pre-Sales → Purchasing), raised from here for chosen BOQ lines; the
 *   quote is recorded on the estimate with the vendor's SAP code, quote
 *   number, dates and file. The code is checked against SAP once CD-28
 *   connects B1;
 * - "ready for Pricing" (handoff 3) is an approved version whose estimate
 *   is complete (`SolutionsService`).
 *
 * Pre-Sales writes it (`presales.solution.manage`); sales read it.
 */
@Injectable()
export class CostService {
  private readonly logger = new Logger(CostService.name);

  constructor(
    private readonly solutions: SolutionsService,
    private readonly versions: SolutionVersionRepository,
    private readonly quotes: SolutionPartnerQuoteRepository,
    private readonly configs: CrmConfigRepository,
    private readonly opportunities: OpportunityRepository,
    private readonly requests: RequestsService,
    private readonly requestRows: RequestRepository,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  async saveLabor(
    id: string,
    versionNo: number,
    dto: SaveLaborDto,
    actor: Principal,
  ) {
    const solution = await this.solutions.requireManageable(id, actor);
    const version = await this.requireCostable(id, versionNo);
    const config = (await this.configs.findFirst({
      where: { companyId: solution.companyId },
      select: { presalesLaborRates: true },
    })) as { presalesLaborRates: unknown } | null;
    const { lines, problems } = cleanLabor(
      dto.lines,
      readLaborRates(config?.presalesLaborRates),
    );
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'lines', reason })),
      );
    }
    await this.transactions.execute(async (prisma) => {
      const moved = await this.versions.updateMany(
        {
          where: { id: version.id, status: { in: ['draft', 'locked'] } },
          data: {
            labor: lines as unknown as Prisma.InputJsonValue,
            updatedBy: actor.userId,
          },
        },
        { prisma },
      );
      if (moved.count !== 1) {
        throw new AppError(
          'CONFLICT',
          'เวอร์ชันนี้ถูกแทนแล้ว — แก้ต้นทุนไม่ได้',
        );
      }
      await this.record(
        'presales.solution.labor_saved',
        solution,
        id,
        actor,
        prisma,
        {
          after: { versionNo, lines: lines.length },
        },
      );
    });
    return this.solutions.findOne(id, actor, versionNo);
  }

  async saveQuote(
    id: string,
    versionNo: number,
    quoteId: string | null,
    dto: SavePartnerQuoteDto,
    actor: Principal,
  ) {
    const solution = await this.solutions.requireManageable(id, actor);
    const version = await this.requireCostable(id, versionNo);
    const { lines, problems } = cleanQuoteLines(dto.lines, version.boq);
    for (const [field, value] of [
      ['quote_date', dto.quote_date],
      ['valid_until', dto.valid_until],
    ] as const) {
      if (value && !ISO_DATE.test(value)) {
        problems.push(`${field}: วันที่ไม่ถูกต้อง`);
      }
    }
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'lines', reason })),
      );
    }
    if (dto.request_id)
      await this.requireVendorQuoteRequest(dto.request_id, solution);
    if (!quoteId) {
      const count = await this.quotes.count({
        where: { versionId: version.id, deletedAt: null },
      });
      if (count >= MAX_QUOTES_PER_VERSION) {
        throw new AppError(
          'VALIDATION_FAILED',
          `ใบเสนอราคาได้ไม่เกิน ${MAX_QUOTES_PER_VERSION} ใบต่อเวอร์ชัน`,
          [{ field: 'lines', reason: 'too_many' }],
        );
      }
    } else {
      await this.requireQuote(version.id, quoteId);
    }
    const fields = {
      vendorName: dto.vendor_name.trim(),
      vendorCode: dto.vendor_code?.trim() ?? '',
      quoteNo: dto.quote_no?.trim() ?? '',
      quoteDate: dto.quote_date ? day(dto.quote_date) : null,
      validUntil: dto.valid_until ? day(dto.valid_until) : null,
      requestId: dto.request_id ?? null,
      lines: lines as unknown as Prisma.InputJsonValue,
    };
    await this.transactions.execute(async (prisma) => {
      if (quoteId) {
        await this.quotes.update(
          {
            where: { id: quoteId },
            data: { ...fields, updatedBy: actor.userId },
          },
          { prisma },
        );
      } else {
        const last = (await this.quotes.findFirst(
          {
            where: { versionId: version.id },
            orderBy: { seq: 'desc' },
            select: { seq: true },
          },
          { prisma },
        )) as { seq: number } | null;
        await this.quotes.create(
          {
            data: {
              companyId: solution.companyId,
              solutionId: id,
              versionId: version.id,
              seq: (last?.seq ?? 0) + 1,
              createdBy: actor.userId,
              ...fields,
            },
          },
          { prisma },
        );
      }
      await this.record(
        quoteId
          ? 'presales.solution.partner_quote_updated'
          : 'presales.solution.partner_quote_added',
        solution,
        id,
        actor,
        prisma,
        {
          after: {
            versionNo,
            quoteId,
            vendorName: fields.vendorName,
            vendorCode: fields.vendorCode,
            lines: lines.length,
          },
        },
      );
    });
    return this.solutions.findOne(id, actor, versionNo);
  }

  async removeQuote(
    id: string,
    versionNo: number,
    quoteId: string,
    actor: Principal,
  ) {
    const solution = await this.solutions.requireManageable(id, actor);
    const version = await this.requireCostable(id, versionNo);
    const quote = await this.requireQuote(version.id, quoteId);
    await this.transactions.execute(async (prisma) => {
      await this.quotes.update(
        {
          where: { id: quoteId },
          data: { deletedAt: new Date(), updatedBy: actor.userId },
        },
        { prisma },
      );
      await this.record(
        'presales.solution.partner_quote_removed',
        solution,
        id,
        actor,
        prisma,
        {
          before: { versionNo, quoteId, vendorName: quote.vendorName },
        },
      );
    });
    return this.solutions.findOne(id, actor, versionNo);
  }

  async uploadQuoteFile(
    id: string,
    versionNo: number,
    quoteId: string,
    file: UploadedFile | undefined,
    actor: Principal,
  ) {
    if (!file) {
      throw new AppError('VALIDATION_FAILED', 'กรุณาเลือกไฟล์', [
        { field: 'file', reason: 'required' },
      ]);
    }
    if (file.size > MAX_QUOTE_FILE_BYTES) {
      throw new AppError('VALIDATION_FAILED', 'ไฟล์ใหญ่เกิน 25 MB', [
        { field: 'file', reason: 'too_large' },
      ]);
    }
    const solution = await this.solutions.requireManageable(id, actor);
    const version = await this.requireCostable(id, versionNo);
    await this.requireQuote(version.id, quoteId);
    const fileName = safeFileName(file.originalname);
    const storageKey = `solutions/${id}/quotes/${quoteId}/${randomUUID()}/${fileName}`;
    await this.storage.put(storageKey, file.buffer, {
      contentType: file.mimetype || 'application/octet-stream',
      size: file.size,
    });
    try {
      await this.transactions.execute(async (prisma) => {
        await this.quotes.update(
          {
            where: { id: quoteId },
            data: {
              fileName,
              mimeType: file.mimetype || 'application/octet-stream',
              sizeBytes: file.size,
              storageKey,
              updatedBy: actor.userId,
            },
          },
          { prisma },
        );
        await this.record(
          'presales.solution.partner_quote_file',
          solution,
          id,
          actor,
          prisma,
          {
            after: { versionNo, quoteId, fileName, sizeBytes: file.size },
          },
        );
      });
    } catch (error) {
      await this.storage
        .remove(storageKey)
        .catch((cleanup: unknown) =>
          this.logger.warn(
            `orphaned quote file ${storageKey}: ${String(cleanup)}`,
          ),
        );
      throw error;
    }
    return this.solutions.findOne(id, actor, versionNo);
  }

  async downloadQuoteFile(
    id: string,
    quoteId: string,
    actor: Principal,
  ): Promise<{ fileName: string; mimeType: string; stream: Readable }> {
    await this.solutions.requireReadable(id, actor);
    const quote = (await this.quotes.findFirst({
      where: { id: quoteId, solutionId: id, deletedAt: null },
      select: { fileName: true, mimeType: true, storageKey: true },
    })) as {
      fileName: string | null;
      mimeType: string | null;
      storageKey: string | null;
    } | null;
    if (!quote?.storageKey) throw new AppError('NOT_FOUND', 'ไม่พบไฟล์ที่ระบุ');
    return {
      fileName: quote.fileName ?? 'quote',
      mimeType: quote.mimeType ?? 'application/octet-stream',
      stream: await this.storage.get(quote.storageKey),
    };
  }

  /** Raise a draft "ขอราคาจากคู่ค้า" for the chosen BOQ lines. */
  async requestVendorQuote(
    id: string,
    versionNo: number,
    dto: VendorQuoteRequestDto,
    actor: Principal,
  ) {
    const solution = await this.solutions.requireManageable(id, actor);
    const version = await this.requireCostable(id, versionNo);
    const typeCode = await this.vendorQuoteType(solution.companyId);
    if (!typeCode) {
      throw new AppError(
        'CONFLICT',
        'ยังไม่ได้ตั้งประเภทคำขอ "ขอราคาจากคู่ค้า" ในตั้งค่า CRM',
      );
    }
    const items = vendorQuoteItems(version.boq, dto.line_indexes);
    if (!items) {
      throw new AppError(
        'VALIDATION_FAILED',
        'เลือกบรรทัด BOQ อย่างน้อยหนึ่งบรรทัด',
        [{ field: 'line_indexes', reason: 'empty' }],
      );
    }
    const deal = (await this.opportunities.findFirst({
      where: { id: solution.opportunityId },
      select: { opportunityCode: true },
    })) as { opportunityCode: string } | null;
    const created = (await this.requests.create(
      {
        type_code: typeCode,
        ...(deal
          ? { ref_type: 'opportunity', ref_id: deal.opportunityCode }
          : {}),
        form_data: {
          solution_title: solution.title,
          version_no: String(versionNo),
          items,
        },
      },
      actor,
    )) as { id: string; requestNo: string | null };
    await this.transactions.execute(async (prisma) => {
      await this.record(
        'presales.solution.vendor_quote_requested',
        solution,
        id,
        actor,
        prisma,
        {
          after: {
            versionNo,
            requestId: created.id,
            lineIndexes: dto.line_indexes,
          },
        },
      );
    });
    return { request_id: created.id, request_no: created.requestNo };
  }

  // --- helpers -------------------------------------------------------------------

  /** A draft or locked version — a superseded one's estimate is history. */
  private async requireCostable(
    solutionId: string,
    versionNo: number,
  ): Promise<VersionRow> {
    const version = (await this.versions.findFirst({
      where: { solutionId, versionNo },
      select: { id: true, versionNo: true, status: true, boq: true },
    })) as VersionRow | null;
    if (!version) throw new AppError('NOT_FOUND', 'ไม่พบเวอร์ชันที่ระบุ');
    if (version.status === 'superseded') {
      throw new AppError('CONFLICT', 'เวอร์ชันนี้ถูกแทนแล้ว — แก้ต้นทุนไม่ได้');
    }
    return version;
  }

  private async requireQuote(versionId: string, quoteId: string) {
    const quote = (await this.quotes.findFirst({
      where: { id: quoteId, versionId, deletedAt: null },
      select: { vendorName: true },
    })) as { vendorName: string } | null;
    if (!quote) throw new AppError('NOT_FOUND', 'ไม่พบใบเสนอราคาที่ระบุ');
    return quote;
  }

  /** The quote's request must be this company's "ขอราคาจากคู่ค้า". */
  private async requireVendorQuoteRequest(
    requestId: string,
    solution: { companyId: string },
  ) {
    const [typeCode, request] = await Promise.all([
      this.vendorQuoteType(solution.companyId),
      this.requestRows.findFirst({
        where: { id: requestId, companyId: solution.companyId },
        select: { typeCode: true },
      }) as Promise<{ typeCode: string } | null>,
    ]);
    if (!request || !typeCode || request.typeCode !== typeCode) {
      throw new AppError(
        'VALIDATION_FAILED',
        'ไม่พบคำขอ "ขอราคาจากคู่ค้า" ที่อ้าง',
        [{ field: 'request_id', reason: 'not_found' }],
      );
    }
  }

  private async vendorQuoteType(companyId: string): Promise<string | null> {
    const config = (await this.configs.findFirst({
      where: { companyId },
      select: { vendorQuoteTypeCode: true },
    })) as { vendorQuoteTypeCode: string | null } | null;
    return config?.vendorQuoteTypeCode ?? null;
  }

  private record(
    eventType: string,
    solution: { companyId: string },
    solutionId: string,
    actor: Principal,
    prisma: Prisma.TransactionClient,
    change: { before?: Prisma.InputJsonValue; after?: Prisma.InputJsonValue },
  ) {
    return this.audit.record(
      {
        eventType,
        companyId: solution.companyId,
        ...auditActor(actor),
        resourceType: 'solution',
        resourceId: solutionId,
        ...change,
      },
      { prisma },
    );
  }
}
