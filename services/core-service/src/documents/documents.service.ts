import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  AppError,
  AuditWriter,
  auditActor,
  paginated,
  PrismaTransactionService,
  toSkipTake,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import { CompanyMemberRepository } from '../access/company-member.repository';
import { type DocumentKind, isoDay, issueDateFor } from './document-rules';
import { DocumentsQueryDto, UpdateDocumentDto } from './documents.dto';
import { CompanyDocumentRepository } from './documents.repositories';

export interface DocumentRow {
  id: string;
  companyId: string;
  kind: string;
  title: string;
  description: string | null;
  issueDate: Date | null;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  storageKey: string;
  uploadedBy: string;
  createdAt: Date;
  updatedBy: string | null;
  updatedAt: Date;
  archivedAt: Date | null;
  archivedBy: string | null;
}

/**
 * Company documents (settings) — the rows. Files live on object storage and
 * are handled by `DocumentFilesService`, which only the processes that hold
 * storage provide. Nothing is deleted: archiving hides a document from the
 * External API and keeps it on the settings screen.
 */
@Injectable()
export class DocumentsService {
  constructor(
    private readonly documents: CompanyDocumentRepository,
    private readonly people: CompanyMemberRepository,
    private readonly transactions: PrismaTransactionService,
    private readonly audit: AuditWriter,
  ) {}

  /**
   * One company's documents. `includeArchived` is the settings screen's;
   * the External API always passes false.
   */
  async list(
    companyId: string,
    query: DocumentsQueryDto,
    includeArchived = false,
  ) {
    const where: Prisma.CompanyDocumentWhereInput = {
      companyId,
      ...(includeArchived ? {} : { archivedAt: null }),
      ...(query.kind ? { kind: query.kind } : {}),
    };
    const q = query.q?.trim();
    if (q) {
      where.OR = [
        { title: { contains: q, mode: 'insensitive' } },
        { description: { contains: q, mode: 'insensitive' } },
        { fileName: { contains: q, mode: 'insensitive' } },
      ];
    }
    if (query.issued_from || query.issued_to) {
      where.issueDate = {
        ...(query.issued_from
          ? { gte: new Date(`${query.issued_from.slice(0, 10)}T00:00:00.000Z`) }
          : {}),
        ...(query.issued_to
          ? { lte: new Date(`${query.issued_to.slice(0, 10)}T00:00:00.000Z`) }
          : {}),
      };
    }
    const { skip, take } = toSkipTake(query);
    const [rows, total] = await Promise.all([
      this.documents.findMany({
        where,
        orderBy: [
          { issueDate: { sort: 'desc', nulls: 'last' } },
          { createdAt: 'desc' },
        ],
        skip,
        take,
      }) as Promise<DocumentRow[]>,
      this.documents.count({ where }),
    ]);
    const names = await this.names(rows.map((row) => row.uploadedBy));
    return paginated(
      rows.map((row) => this.view(row, names)),
      query,
      total,
    );
  }

  async one(companyId: string, id: string, includeArchived = false) {
    const row = await this.require(companyId, id, includeArchived);
    return this.view(row, await this.names([row.uploadedBy]));
  }

  /** Another company's id, or an archived one off the screen, is 404 (SCOPE-03). */
  async require(
    companyId: string,
    id: string,
    includeArchived = false,
  ): Promise<DocumentRow> {
    const row = await this.documents.findFirst({
      where: {
        id,
        companyId,
        ...(includeArchived ? {} : { archivedAt: null }),
      },
    });
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบเอกสาร');
    return row;
  }

  async update(actor: Principal, id: string, dto: UpdateDocumentDto) {
    const row = await this.require(actor.activeCompanyId, id, true);
    if (row.archivedAt) {
      throw new AppError('CONFLICT', 'เอกสารนี้เลิกใช้แล้ว — เปิดใช้ก่อนแก้ไข');
    }
    const data: Prisma.CompanyDocumentUpdateInput = { updatedBy: actor.userId };
    if (dto.title !== undefined) data.title = dto.title.trim();
    if (dto.description !== undefined) {
      data.description = dto.description?.trim() || null;
    }
    if (dto.issue_date !== undefined) {
      const issue = issueDateFor(row.kind as DocumentKind, dto.issue_date);
      if (!issue.ok) {
        throw new AppError('VALIDATION_FAILED', issue.reason, [
          { field: 'issue_date', reason: issue.reason },
        ]);
      }
      data.issueDate = issue.date;
    }
    await this.transactions.execute(async (prisma) => {
      await prisma.companyDocument.update({ where: { id }, data });
      await this.audit.record(
        {
          eventType: 'document.updated',
          companyId: actor.activeCompanyId,
          ...auditActor(actor),
          resourceType: 'company_document',
          resourceId: id,
          before: {
            title: row.title,
            description: row.description,
            issue_date: isoDay(row.issueDate),
          },
          after: {
            title: dto.title,
            description: dto.description,
            issue_date: dto.issue_date,
          },
        },
        { prisma },
      );
    });
    return this.one(actor.activeCompanyId, id, true);
  }

  /** Archive (`archived` true) or bring back. */
  async archive(actor: Principal, id: string, archived: boolean) {
    const row = await this.require(actor.activeCompanyId, id, true);
    if (!!row.archivedAt === archived) {
      return this.one(actor.activeCompanyId, id, true);
    }
    await this.transactions.execute(async (prisma) => {
      await prisma.companyDocument.update({
        where: { id },
        data: archived
          ? { archivedAt: new Date(), archivedBy: actor.userId }
          : { archivedAt: null, archivedBy: null },
      });
      await this.audit.record(
        {
          eventType: archived ? 'document.archived' : 'document.restored',
          companyId: actor.activeCompanyId,
          ...auditActor(actor),
          resourceType: 'company_document',
          resourceId: id,
          after: { title: row.title },
        },
        { prisma },
      );
    });
    return this.one(actor.activeCompanyId, id, true);
  }

  view(row: DocumentRow, names: Map<string, string>) {
    return {
      id: row.id,
      kind: row.kind,
      title: row.title,
      description: row.description,
      issue_date: isoDay(row.issueDate),
      file_name: row.fileName,
      mime_type: row.mimeType,
      size_bytes: row.sizeBytes,
      uploaded_by: {
        id: row.uploadedBy,
        name: names.get(row.uploadedBy) ?? null,
      },
      uploaded_at: row.createdAt,
      updated_at: row.updatedAt,
      archived_at: row.archivedAt,
    };
  }

  private async names(ids: string[]) {
    const unique = [...new Set(ids.filter(Boolean))];
    if (!unique.length) return new Map<string, string>();
    const users = (await this.people.findMany({
      where: { id: { in: unique } },
      select: { id: true, displayName: true },
    })) as { id: string; displayName: string }[];
    return new Map(users.map((user) => [user.id, user.displayName]));
  }
}
