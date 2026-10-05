import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AppError,
  AuditWriter,
  auditActor,
  hasPermission,
  OBJECT_STORAGE,
  Principal,
  PrismaService,
} from '@request-management/share';
import type { ObjectStorage } from '@request-management/share';
import { safeFileName } from '../requests/attachments.service';
import {
  articleProblems,
  FILE_TYPES,
  helpfulScore,
  likePattern,
  MAX_FILE_BYTES,
  MAX_FILES_PER_ARTICLE,
  nextArticleNo,
  normalizeTags,
  publishProblems,
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
}

export interface SearchArticles {
  q?: string;
  status?: ArticleStatus | 'mine';
  categoryId?: string;
  productCode?: string;
  tag?: string;
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
}

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
 * edit any article, publish, archive and keep the categories. The review
 * and approval steps come with CD-260; customer-facing layers with CD-261.
 */
@Injectable()
export class KbService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditWriter,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
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
    for (const term of terms) {
      const p = param(likePattern(term));
      const tags = `array_to_string(a.tags, ' ')`;
      const codes = `array_to_string(a."productCodes", ' ')`;
      where.push(
        `(a.title ILIKE ${p} OR a.summary ILIKE ${p} OR a.body ILIKE ${p}
          OR ${tags} ILIKE ${p} OR ${codes} ILIKE ${p})`,
      );
      scores.push(
        `(CASE WHEN a.title ILIKE ${p} THEN 5 ELSE 0 END
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

    const rows = await this.prisma.$queryRawUnsafe<
      (ArticleRow & { score: number })[]
    >(
      `SELECT a.*, (${score})::float AS score
       FROM kb_articles a
       WHERE ${where.join(' AND ')}
       ORDER BY ${terms.length ? 'score DESC,' : ''}
                COALESCE(a."publishedAt", a."updatedAt") DESC
       LIMIT ${limit}`,
      ...params,
    );
    const names = await this.people(rows.flatMap((r) => [r.authorId]));
    const categories = await this.categoryNames(companyId);
    return {
      canManage: manage,
      terms,
      items: rows.map((row) => ({
        ...this.card(row, names, categories),
        score: terms.length ? Math.round(row.score * 10) / 10 : null,
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
    const [names, categories, files, mine] = await Promise.all([
      this.people([row.authorId, row.publishedBy, row.updatedBy]),
      this.categoryNames(row.companyId),
      this.prisma.kbArticleFile.findMany({
        where: { articleId: id, deletedAt: null },
        orderBy: { uploadedAt: 'asc' },
      }),
      this.prisma.kbArticleRating.findUnique({
        where: { articleId_userId: { articleId: id, userId: actor.userId } },
      }),
    ]);
    const canEdit = this.canEdit(actor, row);
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
      canEdit,
      canPublish: hasPermission(actor, MANAGE) && row.status !== 'published',
      canArchive: hasPermission(actor, MANAGE) && row.status === 'published',
    };
  }

  async create(actor: Principal, input: SaveArticle) {
    const data = await this.clean(actor.activeCompanyId, input);
    for (let attempt = 0; ; attempt++) {
      const last = await this.prisma.kbArticle.findFirst({
        where: { companyId: actor.activeCompanyId },
        orderBy: { articleNo: 'desc' },
        select: { articleNo: true },
      });
      try {
        const row = await this.prisma.kbArticle.create({
          data: {
            ...data,
            companyId: actor.activeCompanyId,
            articleNo: nextArticleNo(last?.articleNo ?? null),
            authorId: actor.userId,
          },
        });
        await this.record(actor, row.companyId, 'kb.article.created', row.id, {
          articleNo: row.articleNo,
          title: row.title,
        });
        return this.findOne(actor, row.id, false);
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
    if (!this.canEdit(actor, row)) {
      throw new AppError(
        'FORBIDDEN',
        'แก้ได้เฉพาะผู้เขียน (ขณะยังเป็นฉบับร่าง) หรือผู้ดูแลคลังความรู้',
      );
    }
    const data = await this.clean(row.companyId, input);
    if (row.status === 'published') {
      const problems = publishProblems(data);
      if (problems.length) throw this.invalid(problems);
    }
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

  async publish(actor: Principal, id: string) {
    const row = await this.managed(actor, id);
    if (row.status === 'published')
      throw new AppError('CONFLICT', 'เผยแพร่อยู่แล้ว');
    const problems = publishProblems(row);
    if (problems.length) throw this.invalid(problems);
    await this.prisma.kbArticle.update({
      where: { id },
      data: {
        status: 'published',
        publishedAt: new Date(),
        publishedBy: actor.userId,
        archivedAt: null,
        archivedBy: null,
      },
    });
    await this.record(actor, row.companyId, 'kb.article.published', id, {
      articleNo: row.articleNo,
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

  /** Back to a draft to rework (an archived one, or a published one withdrawn). */
  async reopen(actor: Principal, id: string) {
    const row = await this.managed(actor, id);
    if (row.status === 'draft')
      throw new AppError('CONFLICT', 'เป็นฉบับร่างอยู่แล้ว');
    await this.prisma.kbArticle.update({
      where: { id },
      data: { status: 'draft', updatedBy: actor.userId },
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
    const data = {
      title: input.title.trim(),
      summary: input.summary?.trim() || null,
      body: input.body ?? '',
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
    const problems = articleProblems(data);
    if (data.categoryId) {
      const category = await this.prisma.kbCategory.findFirst({
        where: { id: data.categoryId, companyId },
      });
      if (!category) problems.push('ไม่พบหมวดที่เลือก');
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
        row.authorId === actor.userId ||
        hasPermission(actor, MANAGE));
    if (!row || !visible) throw new AppError('NOT_FOUND', 'ไม่พบบทความที่ระบุ');
    return row;
  }

  private async managed(actor: Principal, id: string) {
    if (!hasPermission(actor, MANAGE))
      throw new AppError('FORBIDDEN', 'ทำได้เฉพาะผู้ดูแลคลังความรู้');
    return this.readable(actor, id);
  }

  private canEdit(actor: Principal, row: ArticleRow) {
    return (
      hasPermission(actor, MANAGE) ||
      (row.authorId === actor.userId && row.status === 'draft')
    );
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
      author: names.get(row.authorId) ?? row.authorId,
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
