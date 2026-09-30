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
import { safeFileName } from '../requests/attachments.service';
import {
  SolutionTorClauseRepository,
  SolutionTorFileRepository,
  SolutionTorRepository,
} from './solution.repositories';
import { SolutionsService } from './solutions.service';
import { clausesFromText } from './solution-rules';
import type {
  BulkTorClausesDto,
  CreateTorClauseDto,
  SaveTorDto,
  UpdateTorClauseDto,
} from './dto/solution.dto';

/** A TOR with its annexes is big; this is generous without inviting video. */
export const MAX_TOR_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_TOR_FILES = 30;
export const MAX_TOR_CLAUSES = 1000;

interface UploadedFile {
  readonly originalname: string;
  readonly mimetype: string;
  readonly size: number;
  readonly buffer: Buffer;
}

/**
 * CD-138 — ตอบ TOR / RFP (user decisions 30 ก.ย. 2569):
 *
 * - on the Solution, apart from its versions: the TOR's key facts (buyer,
 *   project number, submission deadline, bid bond — kept for the Bid /
 *   No-Bid work of the government axis later), the original files, and its
 *   clauses one by one, each mandatory or not, with how the offer complies
 *   (comply / partial / not comply), the response and where it is covered;
 * - a mandatory clause unanswered or answered "not comply" keeps the
 *   Solution from going for approval now (`approvalBlocker`), and will keep
 *   the proposal from going out when CD-137 exists. "Partial" counts as
 *   answered but is flagged.
 *
 * Pre-Sales writes it (`presales.solution.manage`); sales read it.
 */
@Injectable()
export class TorService {
  private readonly logger = new Logger(TorService.name);

  constructor(
    private readonly solutions: SolutionsService,
    private readonly tors: SolutionTorRepository,
    private readonly files: SolutionTorFileRepository,
    private readonly clauses: SolutionTorClauseRepository,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  async saveFacts(id: string, dto: SaveTorDto, actor: Principal) {
    const solution = await this.solutions.requireManageable(id, actor);
    let deadline: Date | null | undefined;
    if (dto.submission_deadline !== undefined) {
      deadline = dto.submission_deadline
        ? new Date(dto.submission_deadline)
        : null;
      if (deadline && Number.isNaN(deadline.getTime())) {
        throw new AppError('VALIDATION_FAILED', 'กำหนดยื่นไม่ถูกต้อง', [
          { field: 'submission_deadline', reason: 'invalid' },
        ]);
      }
    }
    const fields = {
      ...(dto.buyer !== undefined ? { buyer: dto.buyer.trim() } : {}),
      ...(dto.project_no !== undefined
        ? { projectNo: dto.project_no.trim() }
        : {}),
      ...(deadline !== undefined ? { submissionDeadline: deadline } : {}),
      ...(dto.bid_bond !== undefined ? { bidBond: dto.bid_bond.trim() } : {}),
      ...(dto.note !== undefined ? { note: dto.note.trim() } : {}),
    };
    await this.transactions.execute(async (prisma) => {
      await this.tors.upsert(
        {
          where: { solutionId: id },
          create: {
            companyId: solution.companyId,
            solutionId: id,
            createdBy: actor.userId,
            ...fields,
          },
          update: { ...fields, updatedBy: actor.userId },
        },
        { prisma },
      );
      await this.record(
        'presales.solution.tor_saved',
        solution,
        id,
        actor,
        prisma,
        {
          after: {
            fields: Object.keys(dto).filter(
              (key) => dto[key as keyof SaveTorDto] !== undefined,
            ),
          },
        },
      );
    });
    return this.solutions.findOne(id, actor);
  }

  // --- files ---------------------------------------------------------------------

  async uploadFile(
    id: string,
    file: UploadedFile | undefined,
    actor: Principal,
  ) {
    if (!file) {
      throw new AppError('VALIDATION_FAILED', 'กรุณาเลือกไฟล์', [
        { field: 'file', reason: 'required' },
      ]);
    }
    if (file.size > MAX_TOR_FILE_BYTES) {
      throw new AppError('VALIDATION_FAILED', 'ไฟล์ใหญ่เกิน 50 MB', [
        { field: 'file', reason: 'too_large' },
      ]);
    }
    const solution = await this.solutions.requireManageable(id, actor);
    const count = await this.files.count({
      where: { solutionId: id, deletedAt: null },
    });
    if (count >= MAX_TOR_FILES) {
      throw new AppError(
        'VALIDATION_FAILED',
        `แนบไฟล์ TOR ได้ไม่เกิน ${MAX_TOR_FILES} ไฟล์`,
        [{ field: 'file', reason: 'too_many' }],
      );
    }
    const fileId = randomUUID();
    const fileName = safeFileName(file.originalname);
    const storageKey = `solutions/${id}/tor/${fileId}/${fileName}`;
    await this.storage.put(storageKey, file.buffer, {
      contentType: file.mimetype || 'application/octet-stream',
      size: file.size,
    });
    try {
      await this.transactions.execute(async (prisma) => {
        await this.files.create(
          {
            data: {
              id: fileId,
              companyId: solution.companyId,
              solutionId: id,
              fileName,
              mimeType: file.mimetype || 'application/octet-stream',
              sizeBytes: file.size,
              storageKey,
              uploadedBy: actor.userId,
            },
          },
          { prisma },
        );
        await this.record(
          'presales.solution.tor_file_added',
          solution,
          id,
          actor,
          prisma,
          {
            after: { fileId, fileName, sizeBytes: file.size },
          },
        );
      });
    } catch (error) {
      await this.storage
        .remove(storageKey)
        .catch((cleanup: unknown) =>
          this.logger.warn(
            `orphaned TOR file ${storageKey}: ${String(cleanup)}`,
          ),
        );
      throw error;
    }
    return this.solutions.findOne(id, actor);
  }

  async downloadFile(
    id: string,
    fileId: string,
    actor: Principal,
  ): Promise<{ fileName: string; mimeType: string; stream: Readable }> {
    await this.solutions.requireReadable(id, actor);
    const file = (await this.files.findFirst({
      where: { id: fileId, solutionId: id, deletedAt: null },
      select: { fileName: true, mimeType: true, storageKey: true },
    })) as { fileName: string; mimeType: string; storageKey: string } | null;
    if (!file) throw new AppError('NOT_FOUND', 'ไม่พบไฟล์ที่ระบุ');
    return {
      fileName: file.fileName,
      mimeType: file.mimeType,
      stream: await this.storage.get(file.storageKey),
    };
  }

  /** Soft delete; the object stays, as every document here does. */
  async removeFile(id: string, fileId: string, actor: Principal) {
    const solution = await this.solutions.requireManageable(id, actor);
    const file = (await this.files.findFirst({
      where: { id: fileId, solutionId: id, deletedAt: null },
      select: { fileName: true },
    })) as { fileName: string } | null;
    if (!file) throw new AppError('NOT_FOUND', 'ไม่พบไฟล์ที่ระบุ');
    await this.transactions.execute(async (prisma) => {
      await this.files.update(
        { where: { id: fileId }, data: { deletedAt: new Date() } },
        { prisma },
      );
      await this.record(
        'presales.solution.tor_file_removed',
        solution,
        id,
        actor,
        prisma,
        {
          before: { fileId, fileName: file.fileName },
        },
      );
    });
    return this.solutions.findOne(id, actor);
  }

  // --- clauses -------------------------------------------------------------------

  async addClause(id: string, dto: CreateTorClauseDto, actor: Principal) {
    return this.addClauses(
      id,
      [
        {
          clauseNo: dto.clause_no?.trim() ?? '',
          text: dto.text.trim(),
          mandatory: dto.mandatory ?? true,
        },
      ],
      actor,
    );
  }

  /** Clauses pasted from the TOR, one per line. */
  async addBulk(id: string, dto: BulkTorClausesDto, actor: Principal) {
    const parsed = clausesFromText(dto.text);
    if (!parsed.length) {
      throw new AppError('VALIDATION_FAILED', 'ไม่พบข้อกำหนดในข้อความ', [
        { field: 'text', reason: 'empty' },
      ]);
    }
    return this.addClauses(
      id,
      parsed.map((row) => ({ ...row, mandatory: true })),
      actor,
    );
  }

  async updateClause(
    id: string,
    clauseId: string,
    dto: UpdateTorClauseDto,
    actor: Principal,
  ) {
    const solution = await this.solutions.requireManageable(id, actor);
    const row = await this.requireClause(id, clauseId);
    await this.transactions.execute(async (prisma) => {
      await this.clauses.update(
        {
          where: { id: clauseId },
          data: {
            ...(dto.clause_no !== undefined
              ? { clauseNo: dto.clause_no.trim() }
              : {}),
            ...(dto.text !== undefined ? { text: dto.text.trim() } : {}),
            ...(dto.mandatory !== undefined
              ? { mandatory: dto.mandatory }
              : {}),
            ...(dto.compliance !== undefined
              ? { compliance: dto.compliance }
              : {}),
            ...(dto.response !== undefined
              ? { response: dto.response.trim() }
              : {}),
            ...(dto.reference !== undefined
              ? { reference: dto.reference.trim() }
              : {}),
            updatedBy: actor.userId,
          },
        },
        { prisma },
      );
      await this.record(
        'presales.solution.tor_clause_updated',
        solution,
        id,
        actor,
        prisma,
        {
          before: {
            clauseId,
            mandatory: row.mandatory,
            compliance: row.compliance,
          },
          after: {
            clauseId,
            mandatory: dto.mandatory ?? row.mandatory,
            compliance: dto.compliance ?? row.compliance,
          },
        },
      );
    });
    return this.solutions.findOne(id, actor);
  }

  /** Soft delete — the clause stays findable; its number is not reused. */
  async removeClause(id: string, clauseId: string, actor: Principal) {
    const solution = await this.solutions.requireManageable(id, actor);
    const row = await this.requireClause(id, clauseId);
    await this.transactions.execute(async (prisma) => {
      await this.clauses.update(
        {
          where: { id: clauseId },
          data: { deletedAt: new Date(), updatedBy: actor.userId },
        },
        { prisma },
      );
      await this.record(
        'presales.solution.tor_clause_removed',
        solution,
        id,
        actor,
        prisma,
        {
          before: { clauseId, clauseNo: row.clauseNo, text: row.text },
        },
      );
    });
    return this.solutions.findOne(id, actor);
  }

  // --- helpers -------------------------------------------------------------------

  private async addClauses(
    id: string,
    rows: { clauseNo: string; text: string; mandatory: boolean }[],
    actor: Principal,
  ) {
    const solution = await this.solutions.requireManageable(id, actor);
    const count = await this.clauses.count({
      where: { solutionId: id, deletedAt: null },
    });
    if (count + rows.length > MAX_TOR_CLAUSES) {
      throw new AppError(
        'VALIDATION_FAILED',
        `ข้อกำหนดได้ไม่เกิน ${MAX_TOR_CLAUSES} ข้อ`,
        [{ field: 'text', reason: 'too_many' }],
      );
    }
    const tooLong = rows.findIndex((row) => row.text.length > 8000);
    if (tooLong >= 0) {
      throw new AppError(
        'VALIDATION_FAILED',
        `ข้อกำหนดบรรทัดที่ ${tooLong + 1} ยาวเกิน 8000 ตัวอักษร`,
        [{ field: 'text', reason: 'too_long' }],
      );
    }
    await this.transactions.execute(async (prisma) => {
      // seq counts removed clauses too, so a number never returns.
      const last = (await this.clauses.findFirst(
        {
          where: { solutionId: id },
          orderBy: { seq: 'desc' },
          select: { seq: true },
        },
        { prisma },
      )) as { seq: number } | null;
      const start = (last?.seq ?? 0) + 1;
      await this.clauses.createMany(
        {
          data: rows.map((row, index) => ({
            companyId: solution.companyId,
            solutionId: id,
            seq: start + index,
            clauseNo: row.clauseNo.slice(0, 40),
            text: row.text,
            mandatory: row.mandatory,
            createdBy: actor.userId,
          })),
        },
        { prisma },
      );
      await this.record(
        'presales.solution.tor_clauses_added',
        solution,
        id,
        actor,
        prisma,
        {
          after: { count: rows.length, firstSeq: start },
        },
      );
    });
    return this.solutions.findOne(id, actor);
  }

  private async requireClause(solutionId: string, clauseId: string) {
    const row = (await this.clauses.findFirst({
      where: { id: clauseId, solutionId, deletedAt: null },
    })) as {
      clauseNo: string;
      text: string;
      mandatory: boolean;
      compliance: string;
    } | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบข้อกำหนดที่ระบุ');
    return row;
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
