import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AppError,
  AuditWriter,
  auditActor,
  customerAccessSubject,
  visibleCustomersWhere,
  hasPermission,
  OBJECT_STORAGE,
  Principal,
  PrismaService,
} from '@request-management/share';
import type { ObjectStorage } from '@request-management/share';
import { thaiToday } from '../crm/vendor-costs';
import { safeFileName } from '../requests/attachments.service';
import { byRank, matchFields } from './kb-semantic-rank';
import { KbSemanticService } from './kb-semantic.service';
import {
  articleProblems,
  audienceCustomers,
  audienceProblems,
  FILE_TYPES,
  helpfulScore,
  likePattern,
  MAX_FILE_BYTES,
  MAX_FILES_PER_ARTICLE,
  nextArticleNo,
  normalizeTags,
  OPEN_REVISION,
  reviewState,
  searchTerms,
  type ArticleStatus,
} from './kb-rules';

export interface SaveArticle {
  title: string;
  summary?: string | null;
  body: string;
  categoryId?: string | null;
  tags?: string[];
  productCodes?: string[];
  productGroups?: string[];
  /** CD-261 — internal · customers · selected (with `customerIds`). */
  audience?: string;
  customerIds?: string[];
}

export interface SearchArticles {
  q?: string;
  status?: ArticleStatus | 'in_review' | 'mine';
  categoryId?: string;
  productCode?: string;
  tag?: string;
  audience?: string;
  limit?: number;
}

interface ArticleRow {
  id: string;
  companyId: string;
  articleNo: string;
  title: string;
  summary: string | null;
  body: string;
  status: string;
  categoryId: string | null;
  tags: string[];
  productCodes: string[];
  productGroups: string[];
  source: string;
  sourceRef: string | null;
  authorId: string;
  publishedAt: Date | null;
  publishedBy: string | null;
  archivedAt: Date | null;
  views: number;
  helpfulYes: number;
  helpfulNo: number;
  createdAt: Date;
  updatedAt: Date;
  updatedBy: string | null;
  ownerId: string | null;
  version: number;
  submittedAt: Date | null;
  reviewNote: string | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  nextReviewOn: Date | null;
  lastReviewedAt: Date | null;
  mergedIntoId: string | null;
  audience: string;
  customerIds: string[];
  portalViews: number;
  portalHelpfulYes: number;
  portalHelpfulNo: number;
}

/** CD-260 — warn owners this many days before an article's review day. */
const REVIEW_WARN_DAYS = 30;

const MANAGE = 'kb.article.manage';

/**
 * CD-259 คลังบทความความรู้ (part of CD-22 KBMS) — articles in Markdown, by
 * product (SAP item codes and groups), process category and symptom tags;
 * searched by the words the reader types (Thai has no spaces, so each word
 * must appear somewhere), ranked title > tags > summary > body, nudged by
 * how helpful readers found it.
 *
 * Who: every member of staff reads what is published, rates it and writes
 * drafts (their own, until published); knowledge owners (`kb.article.manage`)
 * edit any article, archive it and keep the categories. Sending for
 * review, approval, revisions, versions, review days and merging are in
 * {@link KbReviewService} (CD-260); customer-facing layers with CD-261.
 */
@Injectable()
export class KbService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditWriter,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    private readonly semantic: KbSemanticService,
  ) {}

  // --- articles ---------------------------------------------------------------

  async search(actor: Principal, query: SearchArticles) {
    const companyId = actor.activeCompanyId;
    const manage = hasPermission(actor, MANAGE);
    const params: unknown[] = [companyId];
    const where: string[] = [`a."companyId" = $1`];
    const param = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };

    const status = query.status ?? 'published';
    if (status === 'mine') {
      where.push(`a."authorId" = ${param(actor.userId)}`);
    } else if (status === 'published' || manage) {
      where.push(`a.status = ${param(status)}`);
    } else {
      // Drafts and archived of others are the owners' business.
      where.push(
        `a.status = ${param(status)}`,
        `a."authorId" = ${param(actor.userId)}`,
      );
    }
    if (query.categoryId) {
      const p = param(query.categoryId);
      where.push(
        `(a."categoryId" = ${p} OR a."categoryId" IN
          (SELECT id FROM kb_categories WHERE "parentId" = ${p}))`,
      );
    }
    if (query.productCode) {
      const code = param(query.productCode);
      where.push(
        `(${code} = ANY(a."productCodes") OR EXISTS (
           SELECT 1 FROM products p WHERE p."companyId" = a."companyId"
             AND p.code = ${code} AND p."groupCode" = ANY(a."productGroups")))`,
      );
    }
    if (query.tag)
      where.push(`${param(query.tag.toLowerCase())} = ANY(a.tags)`);

    const terms = searchTerms(query.q);
    const scores: string[] = [];
    const matches: string[] = [];
    for (const term of terms) {
      const p = param(likePattern(term));
      const tags = `array_to_string(a.tags, ' ')`;
      const codes = `array_to_string(a."productCodes", ' ')`;
      matches.push(
        `(a.title ILIKE ${p} OR a.summary ILIKE ${p} OR a.body ILIKE ${p}
          OR ${tags} ILIKE ${p} OR ${codes} ILIKE ${p} OR a."articleNo" ILIKE ${p})`,
      );
      scores.push(
        `(CASE WHEN a."articleNo" ILIKE ${p} THEN 10 ELSE 0 END
          + CASE WHEN a.title ILIKE ${p} THEN 5 ELSE 0 END
          + CASE WHEN ${tags} ILIKE ${p} OR ${codes} ILIKE ${p} THEN 3 ELSE 0 END
          + CASE WHEN a.summary ILIKE ${p} THEN 2 ELSE 0 END
          + CASE WHEN a.body ILIKE ${p} THEN 1 ELSE 0 END)`,
      );
    }
    const helpful = `(a."helpfulYes" + 1)::float / (a."helpfulYes" + a."helpfulNo" + 2)`;
    const score = scores.length
      ? `${scores.join(' + ')} + 2 * ${helpful}`
      : helpful;
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);

    // CD-267 — and by meaning: published articles whose passages match
    const meaning =
      terms.length && status === 'published'
        ? await this.semantic.search(
            companyId,
            actor.userId,
            query.q ?? '',
            limit,
          )
        : null;
    const meaningIds = [...(meaning?.keys() ?? [])];
    const keywordHit = matches.length
      ? `COALESCE(${matches.join(' AND ')}, FALSE)`
      : 'TRUE';
    const semanticHit = meaningIds.length
      ? `a.id = ANY(${param(meaningIds)}::text[])`
      : 'FALSE';
    if (matches.length) where.push(`(${keywordHit} OR ${semanticHit})`);
    // found by meaning first, so the limit never cuts them off
    const meaningFirst = meaningIds.length ? `${semanticHit} DESC, ` : '';

    const rows = await this.prisma
      .$queryRawUnsafe<
        (ArticleRow & { score: number; keyword_hit: boolean })[]
      >(
        `SELECT a.*, (${score})::float AS score, ${keywordHit} AS keyword_hit
       FROM kb_articles a
       WHERE ${where.join(' AND ')}
       ORDER BY ${meaningFirst}${terms.length ? 'score DESC,' : ''}
                COALESCE(a."publishedAt", a."updatedAt") DESC
       LIMIT ${limit + meaningIds.length}`,
        ...params,
      )
      .then((found) => byRank(found, meaning, limit));
    // CD-261 — a selected-customers article only for those who see one of them
    const allowed = await this.customersSeen(
      actor,
      rows.flatMap((r) => (r.audience === 'selected' ? r.customerIds : [])),
    );
    const visible = rows.filter((r) => this.seesAudience(actor, r, allowed));
    const names = await this.people(
      visible.flatMap((r) => [r.authorId, r.ownerId]),
    );
    const categories = await this.categoryNames(companyId);
    return {
      canManage: manage,
      terms,
      items: visible.map((row) => ({
        ...this.card(row, names, categories),
        score: terms.length ? Math.round(row.score * 10) / 10 : null,
        ...matchFields(row, meaning),
      })),
    };
  }

  async findOne(actor: Principal, id: string, countView = true) {
    const row = await this.readable(actor, id);
    if (countView && row.status === 'published') {
      await this.prisma.kbArticle.update({
        where: { id },
        data: { views: { increment: 1 } },
      });
      row.views += 1;
    }
    const [names, categories, files, mine, revision, merged] =
      await Promise.all([
        this.people([
          row.authorId,
          row.publishedBy,
          row.updatedBy,
          row.ownerId,
          row.reviewedBy,
        ]),
        this.categoryNames(row.companyId),
        this.prisma.kbArticleFile.findMany({
          where: { articleId: id, deletedAt: null },
          orderBy: { uploadedAt: 'asc' },
        }),
        this.prisma.kbArticleRating.findUnique({
          where: { articleId_userId: { articleId: id, userId: actor.userId } },
        }),
        this.prisma.kbArticleRevision.findFirst({
          where: { articleId: id, status: { in: [...OPEN_REVISION] } },
        }),
        row.mergedIntoId
          ? this.prisma.kbArticle.findFirst({
              where: { id: row.mergedIntoId, companyId: row.companyId },
              select: { id: true, articleNo: true, title: true },
            })
          : Promise.resolve(null),
      ]);
    const manage = hasPermission(actor, MANAGE);
    const canEdit = this.canEdit(actor, row);
    const isOwner = row.ownerId === actor.userId;
    const published = row.status === 'published';
    const revisionMine =
      revision && (revision.createdBy === actor.userId || manage)
        ? revision
        : null;
    return {
      ...this.card(row, names, categories),
      body: row.body,
      sourceRef: row.sourceRef,
      publishedBy: row.publishedBy
        ? (names.get(row.publishedBy) ?? null)
        : null,
      updatedBy: row.updatedBy ? (names.get(row.updatedBy) ?? null) : null,
      files: files.map((f) => ({
        id: f.id,
        fileName: f.fileName,
        mimeType: f.mimeType,
        sizeBytes: f.sizeBytes,
        url: `kb/articles/${id}/files/${f.id}`,
      })),
      myRating: mine ? { helpful: mine.helpful, comment: mine.comment } : null,
      // CD-261
      customers: await this.customerNames(actor, row),
      portalViews: row.portalViews,
      portalHelpfulYes: row.portalHelpfulYes,
      portalHelpfulNo: row.portalHelpfulNo,
      // CD-260
      version: row.version,
      ownerId: row.ownerId,
      submittedAt: row.submittedAt,
      reviewNote: row.reviewNote,
      reviewedBy: row.reviewedBy ? (names.get(row.reviewedBy) ?? null) : null,
      reviewedAt: row.reviewedAt,
      lastReviewedAt: row.lastReviewedAt,
      mergedInto: merged,
      openRevision: revision
        ? {
            id: revisionMine ? revision.id : null,
            status: revision.status,
            mine: revision.createdBy === actor.userId,
          }
        : null,
      canEdit,
      canSubmit:
        row.status === 'draft' && (row.authorId === actor.userId || manage),
      canWithdraw:
        row.status === 'in_review' && (row.authorId === actor.userId || manage),
      canApprove:
        manage && (row.status === 'draft' || row.status === 'in_review'),
      canSendBack: manage && row.status === 'in_review',
      canRevise:
        published &&
        !revision &&
        (manage || isOwner || row.authorId === actor.userId),
      canConfirmReview: published && (manage || isOwner),
      canSetOwner: !row.mergedIntoId && (manage || isOwner),
      canMerge: manage && !row.mergedIntoId && row.status !== 'archived',
      canArchive: manage && published,
      canReopen: manage && row.status === 'archived' && !row.mergedIntoId,
    };
  }

  async create(actor: Principal, input: SaveArticle) {
    const row = await this.insertDraft(
      actor.activeCompanyId,
      actor.userId,
      input,
    );
    await this.record(actor, row.companyId, 'kb.article.created', row.id, {
      articleNo: row.articleNo,
      title: row.title,
    });
    return this.findOne(actor, row.id, false);
  }

  /**
   * CD-262 — a draft written for someone by the system (from closed service
   * jobs or a known error): `source` says where it came from.
   */
  async insertDraft(
    companyId: string,
    authorId: string,
    input: SaveArticle,
    origin: { source: string; sourceRef: string | null } = {
      source: 'manual',
      sourceRef: null,
    },
  ) {
    const data = await this.clean(companyId, input);
    for (let attempt = 0; ; attempt++) {
      const last = await this.prisma.kbArticle.findFirst({
        where: { companyId },
        orderBy: { articleNo: 'desc' },
        select: { articleNo: true },
      });
      try {
        return await this.prisma.kbArticle.create({
          data: {
            ...data,
            ...origin,
            companyId,
            articleNo: nextArticleNo(last?.articleNo ?? null),
            authorId,
            ownerId: authorId,
          },
        });
      } catch (error) {
        if (
          attempt < 5 &&
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        )
          continue;
        throw error;
      }
    }
  }

  async update(actor: Principal, id: string, input: SaveArticle) {
    const row = await this.readable(actor, id);
    if (row.status === 'published' || row.status === 'archived') {
      throw new AppError(
        'CONFLICT',
        'บทความที่เผยแพร่แล้วแก้ผ่านฉบับปรับปรุง — ฉบับเดิมยังเผยแพร่อยู่จนกว่าจะอนุมัติ',
      );
    }
    if (!this.canEdit(actor, row)) {
      throw new AppError(
        'FORBIDDEN',
        row.status === 'in_review'
          ? 'บทความรอตรวจอยู่ — ดึงกลับก่อนจึงแก้ได้'
          : 'แก้ได้เฉพาะผู้เขียน (ขณะยังเป็นฉบับร่าง) หรือผู้ดูแลคลังความรู้',
      );
    }
    const data = await this.clean(row.companyId, input);
    await this.prisma.kbArticle.update({
      where: { id },
      data: { ...data, updatedBy: actor.userId },
    });
    await this.record(actor, row.companyId, 'kb.article.updated', id, {
      title: data.title,
      status: row.status,
    });
    return this.findOne(actor, id, false);
  }

  async archive(actor: Principal, id: string, reason: string) {
    const row = await this.managed(actor, id);
    if (row.status !== 'published')
      throw new AppError('CONFLICT', 'เลิกใช้ได้เฉพาะบทความที่เผยแพร่อยู่');
    if (!reason.trim()) throw this.invalid(['ต้องระบุเหตุผลที่เลิกใช้']);
    await this.prisma.kbArticle.update({
      where: { id },
      data: {
        status: 'archived',
        archivedAt: new Date(),
        archivedBy: actor.userId,
      },
    });
    await this.record(actor, row.companyId, 'kb.article.archived', id, {
      articleNo: row.articleNo,
      reason: reason.trim(),
    });
    return this.findOne(actor, id, false);
  }

  /** An archived article back to a draft, to rework and send for review again. */
  async reopen(actor: Principal, id: string) {
    const row = await this.managed(actor, id);
    if (row.status !== 'archived' || row.mergedIntoId)
      throw new AppError(
        'CONFLICT',
        'นำกลับมาได้เฉพาะบทความที่เลิกใช้ (ไม่ใช่ที่ถูกรวม)',
      );
    await this.prisma.kbArticle.update({
      where: { id },
      data: {
        status: 'draft',
        archivedAt: null,
        archivedBy: null,
        updatedBy: actor.userId,
      },
    });
    await this.record(actor, row.companyId, 'kb.article.reopened', id, {
      from: row.status,
    });
    return this.findOne(actor, id, false);
  }

  async remove(actor: Principal, id: string) {
    const row = await this.readable(actor, id);
    if (row.status !== 'draft' || !this.canEdit(actor, row)) {
      throw new AppError(
        'FORBIDDEN',
        'ลบได้เฉพาะฉบับร่าง โดยผู้เขียนหรือผู้ดูแลคลังความรู้ — บทความที่เคยเผยแพร่ให้เลิกใช้แทน',
      );
    }
    if (row.publishedAt) {
      throw new AppError(
        'CONFLICT',
        'บทความนี้เคยเผยแพร่แล้ว ให้เลิกใช้แทนการลบ',
      );
    }
    const files = await this.prisma.kbArticleFile.findMany({
      where: { articleId: id },
    });
    await this.prisma.$transaction([
      this.prisma.kbArticleFile.deleteMany({ where: { articleId: id } }),
      this.prisma.kbArticleRating.deleteMany({ where: { articleId: id } }),
      this.prisma.kbArticle.delete({ where: { id } }),
    ]);
    for (const f of files)
      await this.storage.remove(f.storageKey).catch(() => undefined);
    await this.record(actor, row.companyId, 'kb.article.deleted', id, {
      articleNo: row.articleNo,
      title: row.title,
    });
    return { deleted: true };
  }

  async rate(actor: Principal, id: string, helpful: boolean, comment?: string) {
    const row = await this.readable(actor, id);
    if (row.status !== 'published')
      throw new AppError('CONFLICT', 'ให้คะแนนได้เฉพาะบทความที่เผยแพร่แล้ว');
    await this.prisma.$transaction(async (tx) => {
      await tx.kbArticleRating.upsert({
        where: { articleId_userId: { articleId: id, userId: actor.userId } },
        create: {
          articleId: id,
          userId: actor.userId,
          helpful,
          comment: comment?.trim() || null,
        },
        update: { helpful, comment: comment?.trim() || null },
      });
      const [yes, no] = await Promise.all([
        tx.kbArticleRating.count({ where: { articleId: id, helpful: true } }),
        tx.kbArticleRating.count({ where: { articleId: id, helpful: false } }),
      ]);
      await tx.kbArticle.update({
        where: { id },
        data: { helpfulYes: yes, helpfulNo: no },
      });
    });
    return this.findOne(actor, id, false);
  }

  /** Readers' comments on an article (its editors and owners). */
  async ratings(actor: Principal, id: string) {
    const row = await this.readable(actor, id);
    if (!this.canEdit(actor, row) && !hasPermission(actor, MANAGE)) {
      throw new AppError(
        'FORBIDDEN',
        'ดูความเห็นได้เฉพาะผู้เขียนหรือผู้ดูแลคลังความรู้',
      );
    }
    const rows = await this.prisma.kbArticleRating.findMany({
      where: { articleId: id },
      orderBy: { updatedAt: 'desc' },
    });
    const names = await this.people(rows.map((r) => r.userId));
    return rows.map((r) => ({
      user: names.get(r.userId) ?? r.userId,
      helpful: r.helpful,
      comment: r.comment,
      at: r.updatedAt,
    }));
  }

  // --- files -----------------------------------------------------------------

  async attach(
    actor: Principal,
    id: string,
    file: Express.Multer.File | undefined,
  ) {
    const row = await this.readable(actor, id);
    if (!this.canEdit(actor, row))
      throw new AppError('FORBIDDEN', 'แนบไฟล์ได้เฉพาะผู้แก้บทความได้');
    if (!file) throw this.invalid(['ต้องเลือกไฟล์']);
    if (!(FILE_TYPES as readonly string[]).includes(file.mimetype))
      throw this.invalid([
        'รองรับรูป (PNG JPG GIF WEBP) PDF ข้อความ ZIP และเอกสาร Office',
      ]);
    if (file.size > MAX_FILE_BYTES)
      throw this.invalid(['ไฟล์ใหญ่ไม่เกิน 10 MB']);
    const count = await this.prisma.kbArticleFile.count({
      where: { articleId: id, deletedAt: null },
    });
    if (count >= MAX_FILES_PER_ARTICLE)
      throw this.invalid([
        `บทความหนึ่งแนบได้ไม่เกิน ${MAX_FILES_PER_ARTICLE} ไฟล์`,
      ]);
    const fileId = randomUUID();
    const name = safeFileName(file.originalname);
    const key = `kb/${row.companyId}/${id}/${fileId}/${name}`;
    await this.storage.put(key, file.buffer, {
      contentType: file.mimetype,
      size: file.size,
    });
    try {
      await this.prisma.kbArticleFile.create({
        data: {
          id: fileId,
          articleId: id,
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
    return {
      id: fileId,
      fileName: name,
      mimeType: file.mimetype,
      sizeBytes: file.size,
      url: `kb/articles/${id}/files/${fileId}`,
    };
  }

  async removeFile(actor: Principal, id: string, fileId: string) {
    const row = await this.readable(actor, id);
    if (!this.canEdit(actor, row))
      throw new AppError('FORBIDDEN', 'ลบไฟล์ได้เฉพาะผู้แก้บทความได้');
    const file = await this.prisma.kbArticleFile.findFirst({
      where: { id: fileId, articleId: id, deletedAt: null },
    });
    if (!file) throw new AppError('NOT_FOUND', 'ไม่พบไฟล์ที่ระบุ');
    await this.prisma.kbArticleFile.update({
      where: { id: fileId },
      data: { deletedAt: new Date() },
    });
    return { removed: true };
  }

  async file(
    actor: Principal,
    id: string,
    fileId: string,
  ): Promise<{ stream: Readable; fileName: string; mimeType: string }> {
    await this.readable(actor, id);
    const file = await this.prisma.kbArticleFile.findFirst({
      where: { id: fileId, articleId: id, deletedAt: null },
    });
    if (!file) throw new AppError('NOT_FOUND', 'ไม่พบไฟล์ที่ระบุ');
    return {
      stream: await this.storage.get(file.storageKey),
      fileName: file.fileName,
      mimeType: file.mimeType,
    };
  }

  // --- categories, tags, products ----------------------------------------------

  async categories(actor: Principal) {
    const rows = await this.prisma.kbCategory.findMany({
      where: { companyId: actor.activeCompanyId },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    const counts = await this.prisma.kbArticle.groupBy({
      by: ['categoryId'],
      where: { companyId: actor.activeCompanyId, status: 'published' },
      _count: { _all: true },
    });
    const count = (id: string) =>
      counts.find((c) => c.categoryId === id)?._count._all ?? 0;
    return {
      canManage: hasPermission(actor, MANAGE),
      items: rows.map((r) => ({
        id: r.id,
        name: r.name,
        parentId: r.parentId,
        sortOrder: r.sortOrder,
        active: r.active,
        reviewMonths: r.reviewMonths,
        articles: count(r.id),
      })),
    };
  }

  async saveCategory(
    actor: Principal,
    id: string | null,
    input: {
      name: string;
      parentId?: string | null;
      sortOrder?: number;
      active?: boolean;
      reviewMonths?: number | null;
    },
  ) {
    if (!hasPermission(actor, MANAGE))
      throw new AppError('FORBIDDEN', 'จัดหมวดได้เฉพาะผู้ดูแลคลังความรู้');
    const companyId = actor.activeCompanyId;
    const name = input.name.trim();
    if (!name || name.length > 100)
      throw this.invalid(['ชื่อหมวดยาว 1–100 ตัวอักษร']);
    const parentId = input.parentId || null;
    if (parentId) {
      const parent = await this.prisma.kbCategory.findFirst({
        where: { id: parentId, companyId },
      });
      if (!parent) throw new AppError('NOT_FOUND', 'ไม่พบหมวดแม่ที่ระบุ');
      if (parent.parentId)
        throw this.invalid(['หมวดย่อยลงได้หนึ่งชั้นเท่านั้น']);
      if (parentId === id) throw this.invalid(['หมวดเป็นแม่ของตัวเองไม่ได้']);
    }
    if (id && parentId) {
      const children = await this.prisma.kbCategory.count({
        where: { parentId: id },
      });
      if (children)
        throw this.invalid([
          'หมวดที่มีหมวดย่อยแล้วย้ายไปอยู่ใต้หมวดอื่นไม่ได้',
        ]);
    }
    const clash = await this.prisma.kbCategory.findFirst({
      where: { companyId, parentId, name, ...(id ? { NOT: { id } } : {}) },
    });
    if (clash)
      throw new AppError('CONFLICT', 'มีหมวดชื่อนี้อยู่แล้วในระดับเดียวกัน');
    const data = {
      name,
      parentId,
      sortOrder: input.sortOrder ?? 0,
      active: input.active ?? true,
      reviewMonths: input.reviewMonths ?? null,
    };
    if (id) {
      const row = await this.prisma.kbCategory.findFirst({
        where: { id, companyId },
      });
      if (!row) throw new AppError('NOT_FOUND', 'ไม่พบหมวดที่ระบุ');
      await this.prisma.kbCategory.update({ where: { id }, data });
    } else {
      await this.prisma.kbCategory.create({ data: { ...data, companyId } });
    }
    return this.categories(actor);
  }

  /** Tags in use, most used first — offered while typing. */
  async tags(actor: Principal) {
    const rows = await this.prisma.$queryRawUnsafe<
      { tag: string; n: number }[]
    >(
      `SELECT tag, count(*)::int AS n
       FROM kb_articles, unnest(tags) AS tag
       WHERE "companyId" = $1 AND status <> 'archived'
       GROUP BY tag ORDER BY n DESC, tag LIMIT 200`,
      actor.activeCompanyId,
    );
    return rows;
  }

  /** SAP items and item groups to tie an article to (any member of staff). */
  async products(actor: Principal, q: string | undefined) {
    const term = (q ?? '').trim();
    const items = await this.prisma.product.findMany({
      where: {
        companyId: actor.activeCompanyId,
        active: true,
        ...(term
          ? {
              OR: [
                { code: { contains: term, mode: 'insensitive' } },
                { name: { contains: term, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      select: { code: true, name: true, groupCode: true, groupName: true },
      orderBy: { code: 'asc' },
      take: 30,
    });
    const groups = await this.prisma.product.findMany({
      where: {
        companyId: actor.activeCompanyId,
        groupCode: { not: null },
        ...(term
          ? {
              OR: [
                { groupCode: { contains: term, mode: 'insensitive' } },
                { groupName: { contains: term, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      distinct: ['groupCode'],
      select: { groupCode: true, groupName: true },
      orderBy: { groupCode: 'asc' },
      take: 30,
    });
    return {
      items,
      groups: groups.map((g) => ({ code: g.groupCode!, name: g.groupName })),
    };
  }

  // --- helpers ----------------------------------------------------------------

  private async clean(companyId: string, input: SaveArticle) {
    const audience = input.audience ?? 'internal';
    const data = {
      title: input.title.trim(),
      summary: input.summary?.trim() || null,
      body: input.body ?? '',
      audience,
      customerIds: audienceCustomers(audience, input.customerIds ?? []),
      categoryId: input.categoryId || null,
      tags: normalizeTags(input.tags ?? []),
      productCodes: [
        ...new Set(
          (input.productCodes ?? []).map((c) => c.trim()).filter(Boolean),
        ),
      ],
      productGroups: [
        ...new Set(
          (input.productGroups ?? []).map((c) => c.trim()).filter(Boolean),
        ),
      ],
    };
    const problems = [
      ...articleProblems(data),
      ...audienceProblems(data.audience, data.customerIds),
    ];
    if (data.categoryId) {
      const category = await this.prisma.kbCategory.findFirst({
        where: { id: data.categoryId, companyId },
      });
      if (!category) problems.push('ไม่พบหมวดที่เลือก');
    }
    if (data.customerIds.length) {
      const found = await this.prisma.customer.count({
        where: { companyId, id: { in: data.customerIds } },
      });
      if (found !== data.customerIds.length)
        problems.push('ไม่พบลูกค้าบางรายที่เลือก');
    }
    if (problems.length) throw this.invalid(problems);
    return data;
  }

  private async readable(actor: Principal, id: string): Promise<ArticleRow> {
    const row = (await this.prisma.kbArticle.findFirst({
      where: { id, companyId: actor.activeCompanyId },
    })) as ArticleRow | null;
    const visible =
      row &&
      (row.status === 'published' ||
        // a merged duplicate: readers land on it and are sent to the main one
        !!row.mergedIntoId ||
        row.authorId === actor.userId ||
        row.ownerId === actor.userId ||
        hasPermission(actor, MANAGE));
    if (!row || !visible) throw new AppError('NOT_FOUND', 'ไม่พบบทความที่ระบุ');
    if (row.audience === 'selected' && !row.mergedIntoId) {
      const allowed = await this.customersSeen(actor, row.customerIds);
      if (!this.seesAudience(actor, row, allowed))
        throw new AppError('NOT_FOUND', 'ไม่พบบทความที่ระบุ');
    }
    return row;
  }

  /**
   * CD-261 — of these customers, the ones the caller may see in CRM (the
   * rule of the customer pages, CM-08). Knowledge owners see every article.
   */
  async customersSeen(actor: Principal, ids: readonly string[]) {
    const unique = [...new Set(ids)];
    if (!unique.length || hasPermission(actor, MANAGE)) return new Set(unique);
    const rows = await this.prisma.customer.findMany({
      where: {
        id: { in: unique },
        AND: [visibleCustomersWhere(customerAccessSubject(actor))],
      },
      select: { id: true },
    });
    return new Set(rows.map((r) => r.id));
  }

  /** A selected-customers article: its owners, or someone who sees one of them. */
  private seesAudience(
    actor: Principal,
    row: Pick<ArticleRow, 'audience' | 'customerIds' | 'authorId' | 'ownerId'>,
    allowed: Set<string>,
  ) {
    if (row.audience !== 'selected') return true;
    if (hasPermission(actor, MANAGE)) return true;
    if (row.authorId === actor.userId || row.ownerId === actor.userId)
      return true;
    return row.customerIds.some((id) => allowed.has(id));
  }

  private async customerNames(actor: Principal, row: ArticleRow) {
    if (!row.customerIds.length) return [];
    const allowed = await this.customersSeen(actor, row.customerIds);
    const rows = await this.prisma.customer.findMany({
      where: { id: { in: row.customerIds.filter((id) => allowed.has(id)) } },
      select: { id: true, customerCode: true, nameTh: true },
    });
    return rows.map((c) => ({
      id: c.id,
      code: c.customerCode,
      name: c.nameTh,
    }));
  }

  private async managed(actor: Principal, id: string) {
    if (!hasPermission(actor, MANAGE))
      throw new AppError('FORBIDDEN', 'ทำได้เฉพาะผู้ดูแลคลังความรู้');
    return this.readable(actor, id);
  }

  /** Files go with the text: its editors, or the writer of an open revision. */
  private async canAttach(actor: Principal, row: ArticleRow) {
    if (this.canEdit(actor, row)) return true;
    const revision = await this.prisma.kbArticleRevision.findFirst({
      where: { articleId: row.id, status: { in: ['draft', 'returned'] } },
      select: { createdBy: true },
    });
    return (
      !!revision &&
      (revision.createdBy === actor.userId || hasPermission(actor, MANAGE))
    );
  }

  /** The text itself — a published article changes through a revision. */
  private canEdit(actor: Principal, row: ArticleRow) {
    if (row.status === 'draft')
      return row.authorId === actor.userId || hasPermission(actor, MANAGE);
    return row.status === 'in_review' && hasPermission(actor, MANAGE);
  }

  private card(
    row: ArticleRow,
    names: Map<string, string>,
    categories: Map<string, string>,
  ) {
    return {
      id: row.id,
      articleNo: row.articleNo,
      title: row.title,
      summary: row.summary,
      status: row.status,
      category: row.categoryId
        ? { id: row.categoryId, name: categories.get(row.categoryId) ?? null }
        : null,
      tags: row.tags,
      productCodes: row.productCodes,
      productGroups: row.productGroups,
      source: row.source,
      audience: row.audience,
      author: names.get(row.authorId) ?? row.authorId,
      owner: row.ownerId ? (names.get(row.ownerId) ?? row.ownerId) : null,
      nextReviewOn: row.nextReviewOn
        ? row.nextReviewOn.toISOString().slice(0, 10)
        : null,
      reviewState:
        row.status === 'published'
          ? reviewState(
              row.nextReviewOn
                ? row.nextReviewOn.toISOString().slice(0, 10)
                : null,
              thaiToday(),
              REVIEW_WARN_DAYS,
            )
          : 'none',
      publishedAt: row.publishedAt,
      updatedAt: row.updatedAt,
      views: row.views,
      helpfulYes: row.helpfulYes,
      helpfulNo: row.helpfulNo,
      helpfulPct:
        row.helpfulYes + row.helpfulNo
          ? Math.round(
              (100 * row.helpfulYes) / (row.helpfulYes + row.helpfulNo),
            )
          : null,
      helpfulScore: helpfulScore(row.helpfulYes, row.helpfulNo),
    };
  }

  /** CD-266 — display names, for the gap list. */
  peopleNames(ids: (string | null)[]) {
    return this.people(ids);
  }

  private async people(ids: (string | null)[]) {
    const unique = [...new Set(ids.filter((id): id is string => !!id))];
    if (!unique.length) return new Map<string, string>();
    const users = await this.prisma.user.findMany({
      where: { id: { in: unique } },
      select: { id: true, displayName: true },
    });
    return new Map(users.map((u) => [u.id, u.displayName]));
  }

  private async categoryNames(companyId: string) {
    const rows = await this.prisma.kbCategory.findMany({
      where: { companyId },
      select: { id: true, name: true, parentId: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    return new Map(
      rows.map((r) => [
        r.id,
        r.parentId && byId.get(r.parentId)
          ? `${byId.get(r.parentId)!.name} › ${r.name}`
          : r.name,
      ]),
    );
  }

  private invalid(problems: string[]) {
    return new AppError(
      'VALIDATION_FAILED',
      problems[0],
      problems.map((reason) => ({ field: 'article', reason })),
    );
  }

  private record(
    actor: Principal,
    companyId: string,
    eventType: string,
    id: string,
    after: Prisma.InputJsonObject,
  ) {
    return this.audit.record({
      eventType,
      companyId,
      ...auditActor(actor),
      resourceType: 'kb_article',
      resourceId: id,
      after,
    });
  }
}
