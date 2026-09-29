import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  AppError,
  AuditWriter,
  auditActor,
  hasPermission,
  OBJECT_STORAGE,
  paginated,
  Principal,
  PrismaTransactionService,
  toSkipTake,
} from '@request-management/share';
import type { ObjectStorage } from '@request-management/share';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { CompanyMemberRepository } from '../access/company-member.repository';
import { safeFileName } from '../requests/attachments.service';
import { extractContractText, normalizeText } from './contract-text';
import { contractVisibleWhere } from './contract-visibility';
import {
  ContractAccessRepository,
  ContractDocumentRepository,
  CustomerContractRepository,
} from './contract.repositories';
import { CustomerRepository } from './customer.repository';
import {
  ContractAccessDto,
  ListContractsQueryDto,
  SaveLegalContractDto,
} from './dto/legal-contract.dto';

export const MAX_CONTRACT_FILE_BYTES = 25 * 1024 * 1024;
export const CONTRACT_FILE_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/jpeg',
  'image/png',
] as const;

interface UploadedContractFile {
  readonly originalname: string;
  readonly mimetype: string;
  readonly size: number;
  readonly buffer: Buffer;
}

const isoDay = (value: unknown): string | null =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)
    ? value.slice(0, 10)
    : null;
const asDate = (day: string) => new Date(`${day}T00:00:00Z`);

const LIST_SELECT = {
  id: true,
  contractNo: true,
  title: true,
  kind: true,
  status: true,
  confidential: true,
  startOn: true,
  endOn: true,
  value: true,
  currency: true,
  counterpartyName: true,
  counterpartyTaxId: true,
  ownerUserId: true,
  customer: { select: { id: true, customerCode: true, nameTh: true } },
  _count: { select: { documents: { where: { deletedAt: null } } } },
} as const;

const DOCUMENT_SELECT = {
  id: true,
  fileName: true,
  mimeType: true,
  sizeBytes: true,
  textStatus: true,
  uploadedBy: true,
  uploadedAt: true,
} as const;

interface ContractRow {
  id: string;
  companyId: string;
  customerId: string | null;
  contractNo: string;
  endOn: Date;
  confidential: boolean;
  ownerUserId: string;
  createdBy: string | null;
}

/**
 * CD-161 — คลังสัญญา (CD-13 Legal; user decisions 29 ก.ย. 2569): one
 * repository for the company's contracts — customers' sale/service contracts
 * (the CD-70 register it grows from), NDAs, MSAs, and contracts with parties
 * outside the customer register (a partner, a vendor).
 *
 * - `legal.contract.read` searches it company-wide by number, title, party,
 *   value, end date, kind — and by the words inside an attached PDF (its text
 *   is extracted on upload; a scan has none, and there is no OCR);
 * - `legal.contract.manage` records, edits, attaches files and sets who may
 *   open a confidential contract (ลับพิเศษ): then only manage, the owner, the
 *   recorder and the access list see it — here and on the customer's tab;
 * - every change is audited; files live in object storage like request
 *   attachments (bytes first, row second).
 */
@Injectable()
export class LegalContractsService {
  private readonly logger = new Logger(LegalContractsService.name);

  constructor(
    private readonly contracts: CustomerContractRepository,
    private readonly documents: ContractDocumentRepository,
    private readonly access: ContractAccessRepository,
    private readonly customers: CustomerRepository,
    private readonly members: CompanyMemberRepository,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  async list(actor: Principal, query: ListContractsQueryDto) {
    const { skip, take } = toSkipTake(query);
    const where = this.where(actor, query);
    const [rows, total] = await Promise.all([
      this.contracts.findMany({
        where,
        select: LIST_SELECT,
        orderBy: [{ endOn: 'asc' }, { contractNo: 'asc' }],
        skip,
        take,
      }),
      this.contracts.count({ where }),
    ]);
    return paginated(rows as unknown[], query, total);
  }

  async detail(id: string, actor: Principal) {
    const found = (await this.contracts.findFirst({
      where: { id, AND: [this.base(actor)] },
      select: {
        ...LIST_SELECT,
        note: true,
        opportunityId: true,
        requestId: true,
        renewalOpportunityId: true,
        createdBy: true,
        createdAt: true,
        updatedAt: true,
        documents: {
          where: { deletedAt: null },
          orderBy: { uploadedAt: 'desc' },
          select: DOCUMENT_SELECT,
        },
        access: { select: { userId: true, grantedAt: true } },
      },
    })) as
      | ({
          ownerUserId: string;
          createdBy: string | null;
          documents: { uploadedBy: string }[];
          access: { userId: string }[];
        } & Record<string, unknown>)
      | null;
    // SCOPE-03 — out of reach, or confidential and not for this person: 404.
    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบสัญญาที่ระบุ');
    const names = await this.displayNames([
      found.ownerUserId,
      found.createdBy,
      ...found.documents.map((doc) => doc.uploadedBy),
      ...found.access.map((row) => row.userId),
    ]);
    return {
      ...found,
      ownerName: names.get(found.ownerUserId) ?? null,
      documents: found.documents.map((doc) => ({
        ...doc,
        uploadedByName: names.get(doc.uploadedBy) ?? doc.uploadedBy,
      })),
      access: found.access.map((row) => ({
        ...row,
        displayName: names.get(row.userId) ?? row.userId,
      })),
      canManage: hasPermission(actor, 'legal.contract.manage'),
    };
  }

  async create(dto: SaveLegalContractDto, actor: Principal) {
    const companyId = actor.activeCompanyId;
    const contractNo = dto.contract_no?.trim();
    const title = dto.title?.trim();
    const endOn = isoDay(dto.end_on);
    if (!contractNo || !title || !endOn) {
      throw new AppError(
        'VALIDATION_FAILED',
        'ต้องระบุเลขที่สัญญา ชื่อสัญญา และวันสิ้นสุด',
        [{ field: 'contract', reason: 'required' }],
      );
    }
    const startOn = isoDay(dto.start_on);
    this.assertDates(startOn, endOn);
    const party = await this.party(companyId, dto);
    await this.assertNumberFree(companyId, contractNo);

    return this.transactions.execute(async (prisma) => {
      const row = (await this.contracts.create(
        {
          data: {
            companyId,
            customerId: party.customerId,
            counterpartyName: party.counterpartyName,
            counterpartyTaxId: party.counterpartyTaxId,
            kind: dto.kind ?? 'standard',
            contractNo,
            title,
            startOn: startOn ? asDate(startOn) : null,
            endOn: asDate(endOn),
            value: dto.value ?? null,
            note: dto.note?.trim() || null,
            ownerUserId: party.ownerUserId ?? actor.userId,
            ownerOrgUnitId: party.ownerOrgUnitId ?? actor.orgUnitId,
            createdBy: actor.userId,
            updatedBy: actor.userId,
          },
        },
        { prisma },
      )) as { id: string };
      await this.audit.record(
        {
          eventType: 'legal.contract.created',
          companyId,
          ...auditActor(actor),
          resourceType: 'customer_contract',
          resourceId: row.id,
          after: {
            contractNo,
            kind: dto.kind ?? 'standard',
            customerId: party.customerId,
            counterpartyName: party.counterpartyName,
            endOn,
            value: dto.value ?? null,
          },
        },
        { prisma },
      );
      return row;
    });
  }

  async update(id: string, dto: SaveLegalContractDto, actor: Principal) {
    const before = await this.requireContract(id, actor);
    const endOn = dto.end_on === undefined ? undefined : isoDay(dto.end_on);
    if (dto.end_on !== undefined && !endOn) {
      throw new AppError('VALIDATION_FAILED', 'วันสิ้นสุดไม่ถูกต้อง', [
        { field: 'end_on', reason: 'invalid' },
      ]);
    }
    const startOn =
      dto.start_on === undefined ? undefined : isoDay(dto.start_on);
    this.assertDates(
      startOn ?? null,
      endOn ?? before.endOn.toISOString().slice(0, 10),
    );
    const partyChanged =
      dto.customer_id !== undefined || dto.counterparty_name !== undefined;
    const party = partyChanged ? await this.party(before.companyId, dto) : null;
    const contractNo = dto.contract_no?.trim();
    if (contractNo && contractNo !== before.contractNo) {
      await this.assertNumberFree(before.companyId, contractNo);
    }
    // A new end date starts the renewal reminders over (as CD-70 does).
    const endChanged =
      endOn !== undefined &&
      endOn !== null &&
      endOn !== before.endOn.toISOString().slice(0, 10);

    const data: Prisma.CustomerContractUncheckedUpdateInput = {
      ...(dto.kind ? { kind: dto.kind } : {}),
      ...(contractNo ? { contractNo } : {}),
      ...(dto.title?.trim() ? { title: dto.title.trim() } : {}),
      ...(party
        ? {
            customerId: party.customerId,
            counterpartyName: party.counterpartyName,
            counterpartyTaxId: party.counterpartyTaxId,
          }
        : {}),
      ...(startOn !== undefined
        ? { startOn: startOn ? asDate(startOn) : null }
        : {}),
      ...(endOn ? { endOn: asDate(endOn) } : {}),
      ...(dto.value !== undefined ? { value: dto.value } : {}),
      ...(dto.note !== undefined ? { note: dto.note?.trim() || null } : {}),
      ...(dto.status ? { status: dto.status } : {}),
      ...(endChanged ? { remindedDays: [], status: 'active' } : {}),
      updatedBy: actor.userId,
    };
    return this.transactions.execute(async (prisma) => {
      const row = await this.contracts.update(
        { where: { id }, data },
        { prisma },
      );
      await this.audit.record(
        {
          eventType: 'legal.contract.updated',
          companyId: before.companyId,
          ...auditActor(actor),
          resourceType: 'customer_contract',
          resourceId: id,
          before: {
            contractNo: before.contractNo,
            endOn: before.endOn.toISOString().slice(0, 10),
          },
          after: dto as unknown as Prisma.InputJsonValue,
        },
        { prisma },
      );
      return row;
    });
  }

  /** ลับพิเศษ on/off and the people who may still open it. */
  async setAccess(id: string, dto: ContractAccessDto, actor: Principal) {
    const contract = await this.requireContract(id, actor);
    const userIds = [...new Set(dto.user_ids)];
    if (userIds.length) {
      const known = (await this.members.findMany({
        where: {
          id: { in: userIds },
          companies: { some: { companyId: contract.companyId } },
        },
        select: { id: true },
      })) as { id: string }[];
      const unknown = userIds.filter(
        (userId) => !known.some((row) => row.id === userId),
      );
      if (unknown.length) {
        throw new AppError(
          'VALIDATION_FAILED',
          'ผู้ใช้บางคนไม่ได้อยู่ในบริษัทนี้',
          unknown.map((userId) => ({ field: 'user_ids', reason: userId })),
        );
      }
    }
    await this.transactions.execute(async (prisma) => {
      await this.contracts.update(
        {
          where: { id },
          data: { confidential: dto.confidential, updatedBy: actor.userId },
        },
        { prisma },
      );
      await prisma.contractAccess.deleteMany({
        where: { contractId: id, userId: { notIn: userIds } },
      });
      for (const userId of userIds) {
        await this.access.upsert(
          {
            where: { contractId_userId: { contractId: id, userId } },
            create: { contractId: id, userId, grantedBy: actor.userId },
            update: {},
          },
          { prisma },
        );
      }
      await this.audit.record(
        {
          eventType: 'legal.contract.access_set',
          companyId: contract.companyId,
          ...auditActor(actor),
          resourceType: 'customer_contract',
          resourceId: id,
          before: { confidential: contract.confidential },
          after: { confidential: dto.confidential, userIds },
        },
        { prisma },
      );
    });
    return this.detail(id, actor);
  }

  // --- files ---------------------------------------------------------------

  async upload(
    id: string,
    file: UploadedContractFile | undefined,
    actor: Principal,
  ) {
    if (!file) {
      throw new AppError('VALIDATION_FAILED', 'กรุณาเลือกไฟล์', [
        { field: 'file', reason: 'required' },
      ]);
    }
    if (!(CONTRACT_FILE_TYPES as readonly string[]).includes(file.mimetype)) {
      throw new AppError(
        'VALIDATION_FAILED',
        'แนบได้เฉพาะ PDF, Word หรือรูปภาพ',
        [{ field: 'file', reason: file.mimetype || 'unknown' }],
      );
    }
    if (file.size > MAX_CONTRACT_FILE_BYTES) {
      throw new AppError('VALIDATION_FAILED', 'ไฟล์ใหญ่เกิน 25 MB', [
        { field: 'file', reason: 'too_large' },
      ]);
    }
    const contract = await this.requireContract(id, actor);
    const { status, text } = await extractContractText(
      file.buffer,
      file.mimetype,
    );

    const documentId = randomUUID();
    const fileName = safeFileName(file.originalname);
    const storageKey = `contracts/${contract.id}/${documentId}/${fileName}`;
    await this.storage.put(storageKey, file.buffer, {
      contentType: file.mimetype,
      size: file.size,
    });
    try {
      return await this.transactions.execute(async (prisma) => {
        const row = await this.documents.create(
          {
            data: {
              id: documentId,
              companyId: contract.companyId,
              contractId: contract.id,
              fileName,
              mimeType: file.mimetype,
              sizeBytes: file.size,
              storageKey,
              textStatus: status,
              textContent: text,
              uploadedBy: actor.userId,
            },
            select: DOCUMENT_SELECT,
          },
          { prisma },
        );
        await this.audit.record(
          {
            eventType: 'legal.contract.file_added',
            companyId: contract.companyId,
            ...auditActor(actor),
            resourceType: 'customer_contract',
            resourceId: contract.id,
            after: { documentId, fileName, textStatus: status },
          },
          { prisma },
        );
        return row;
      });
    } catch (error) {
      // The row failed — do not leave an object nobody can reach.
      await this.storage.remove(storageKey).catch(() => undefined);
      throw error;
    }
  }

  async download(
    id: string,
    documentId: string,
    actor: Principal,
  ): Promise<{ fileName: string; mimeType: string; stream: Readable }> {
    const document = await this.requireDocument(id, documentId, actor);
    return {
      fileName: document.fileName,
      mimeType: document.mimeType,
      stream: await this.storage.get(document.storageKey),
    };
  }

  async removeDocument(id: string, documentId: string, actor: Principal) {
    const document = await this.requireDocument(id, documentId, actor);
    await this.documents.update({
      where: { id: documentId },
      data: { deletedAt: new Date(), deletedBy: actor.userId },
    });
    await this.audit.record({
      eventType: 'legal.contract.file_removed',
      companyId: document.companyId,
      ...auditActor(actor),
      resourceType: 'customer_contract',
      resourceId: id,
      before: { documentId, fileName: document.fileName },
    });
    await this.storage
      .remove(document.storageKey)
      .catch((error: Error) =>
        this.logger.warn(
          `CD-161 remove ${document.storageKey}: ${error.message}`,
        ),
      );
    return { removed: true };
  }

  // --- helpers -------------------------------------------------------------

  private base(actor: Principal): Prisma.CustomerContractWhereInput {
    return {
      companyId: actor.activeCompanyId,
      ...contractVisibleWhere(actor),
    };
  }

  private where(
    actor: Principal,
    query: ListContractsQueryDto,
  ): Prisma.CustomerContractWhereInput {
    const and: Prisma.CustomerContractWhereInput[] = [this.base(actor)];
    if (query.kind) and.push({ kind: query.kind });
    if (query.status) and.push({ status: query.status });
    if (query.customer_id) and.push({ customerId: query.customer_id });
    if (query.confidential) {
      and.push({ confidential: query.confidential === 'true' });
    }
    const from = isoDay(query.ends_from);
    const to = isoDay(query.ends_to);
    if (from || to) {
      and.push({
        endOn: {
          ...(from ? { gte: asDate(from) } : {}),
          ...(to ? { lte: asDate(to) } : {}),
        },
      });
    }
    if (query.min_value !== undefined || query.max_value !== undefined) {
      and.push({
        value: {
          ...(query.min_value !== undefined ? { gte: query.min_value } : {}),
          ...(query.max_value !== undefined ? { lte: query.max_value } : {}),
        },
      });
    }
    const search = query.search?.trim();
    if (search) {
      const has = { contains: search, mode: 'insensitive' as const };
      and.push({
        OR: [
          { contractNo: has },
          { title: has },
          { counterpartyName: has },
          { counterpartyTaxId: { contains: search } },
          { note: has },
          { customer: { nameTh: has } },
          { customer: { customerCode: has } },
        ],
      });
    }
    const text = query.text ? normalizeText(query.text) : '';
    if (text) {
      and.push({
        documents: {
          some: {
            deletedAt: null,
            textContent: { contains: text, mode: 'insensitive' },
          },
        },
      });
    }
    return { AND: and };
  }

  /** The customer in the register, or a named outside party — never neither. */
  private async party(companyId: string, dto: SaveLegalContractDto) {
    const customerId = dto.customer_id?.trim() || null;
    if (customerId) {
      const customer = (await this.customers.findFirst({
        where: { id: customerId, companyId, mergedIntoCustomerId: null },
        select: {
          id: true,
          accountOwnerUserId: true,
          ownerOrgUnitId: true,
        },
      })) as {
        id: string;
        accountOwnerUserId: string | null;
        ownerOrgUnitId: string | null;
      } | null;
      if (!customer) {
        throw new AppError('NOT_FOUND', 'ไม่พบลูกค้าที่ระบุในบริษัทนี้');
      }
      return {
        customerId,
        counterpartyName: null,
        counterpartyTaxId: null,
        ownerUserId: customer.accountOwnerUserId,
        ownerOrgUnitId: customer.ownerOrgUnitId,
      };
    }
    const name = dto.counterparty_name?.trim();
    if (!name) {
      throw new AppError(
        'VALIDATION_FAILED',
        'เลือกลูกค้าในทะเบียน หรือระบุชื่อคู่สัญญา',
        [{ field: 'counterparty_name', reason: 'required' }],
      );
    }
    return {
      customerId: null,
      counterpartyName: name,
      counterpartyTaxId: dto.counterparty_tax_id?.trim() || null,
      ownerUserId: null,
      ownerOrgUnitId: null,
    };
  }

  private assertDates(startOn: string | null, endOn: string) {
    if (startOn && startOn > endOn) {
      throw new AppError(
        'VALIDATION_FAILED',
        'วันเริ่มต้องไม่อยู่หลังวันสิ้นสุด',
        [{ field: 'start_on', reason: 'after_end' }],
      );
    }
  }

  private async assertNumberFree(companyId: string, contractNo: string) {
    const taken = await this.contracts.findFirst({
      where: { companyId, contractNo },
      select: { id: true },
    });
    if (taken) {
      throw new AppError('CONFLICT', `เลขที่สัญญา ${contractNo} มีอยู่แล้ว`, [
        { field: 'contract_no', reason: 'taken' },
      ]);
    }
  }

  private async requireContract(
    id: string,
    actor: Principal,
  ): Promise<ContractRow> {
    const found = (await this.contracts.findFirst({
      where: { id, AND: [this.base(actor)] },
      select: {
        id: true,
        companyId: true,
        customerId: true,
        contractNo: true,
        endOn: true,
        confidential: true,
        ownerUserId: true,
        createdBy: true,
      },
    })) as ContractRow | null;
    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบสัญญาที่ระบุ');
    return found;
  }

  private async requireDocument(
    id: string,
    documentId: string,
    actor: Principal,
  ) {
    await this.requireContract(id, actor);
    const document = (await this.documents.findFirst({
      where: { id: documentId, contractId: id, deletedAt: null },
      select: {
        id: true,
        companyId: true,
        fileName: true,
        mimeType: true,
        storageKey: true,
      },
    })) as {
      id: string;
      companyId: string;
      fileName: string;
      mimeType: string;
      storageKey: string;
    } | null;
    if (!document) throw new AppError('NOT_FOUND', 'ไม่พบไฟล์ที่ระบุ');
    return document;
  }

  private async displayNames(ids: (string | null)[]) {
    const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    if (!unique.length) return new Map<string, string>();
    const users = (await this.members.findMany({
      where: { id: { in: unique } },
      select: { id: true, displayName: true },
    })) as { id: string; displayName: string }[];
    return new Map(users.map((user) => [user.id, user.displayName]));
  }
}
