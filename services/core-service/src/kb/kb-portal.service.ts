import type { Readable } from 'node:stream';
import { Inject, Injectable } from '@nestjs/common';
import {
  AppError,
  OBJECT_STORAGE,
  PrismaService,
} from '@request-management/share';
import type { ObjectStorage } from '@request-management/share';
import { likePattern, searchTerms } from './kb-rules';

/** Who reads, as the Portal (CD-249) resolves its session. */
export interface KbPortalViewer {
  companyId: string;
  customerId: string;
  contactId: string;
}

interface PortalRow {
  id: string;
  articleNo: string;
  title: string;
  summary: string | null;
  categoryId: string | null;
  tags: string[];
  productCodes: string[];
  productGroups: string[];
  publishedAt: Date | null;
  updatedAt: Date;
  portalHelpfulYes: number;
  portalHelpfulNo: number;
  for_equipment: boolean;
  score: number;
}

/**
 * CD-261 — the knowledge base as the Customer Portal (CD-249) shows it.
 *
 * A customer's contact reads published articles meant for every customer
 * (`customers`) and those meant for their own company (`selected`, naming
 * it) — never `internal` ones. Those for products the customer has installed
 * (service assets, CD-236: the item, or its SAP item group) come first. Their
 * views and votes are kept apart from staff's.
 *
 * The Portal's public routes (support module, PortalService.viewer) call
 * these; nothing here reads a session itself. A link in an article's Markdown
 * to its own file is `kb/articles/<id>/files/<fileId>` — the Portal maps it
 * to its own route, which ends in {@link KbPortalService.fileForCustomer}.
 */
@Injectable()
export class KbPortalService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  /** The articles this customer may read; `q` as staff search does. */
  async listForCustomer(viewer: KbPortalViewer, q?: string, limit = 50) {
    const products = await this.installedProducts(viewer);
    const params: unknown[] = [
      viewer.companyId,
      viewer.customerId,
      products.codes,
      products.groups,
    ];
    const param = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const where = [
      `a."companyId" = $1`,
      `a.status = 'published'`,
      `(a.audience = 'customers' OR (a.audience = 'selected' AND $2 = ANY(a."customerIds")))`,
    ];
    const scores: string[] = [];
    const terms = searchTerms(q);
    for (const term of terms) {
      const p = param(likePattern(term));
      const tags = `array_to_string(a.tags, ' ')`;
      where.push(
        `(a.title ILIKE ${p} OR a.summary ILIKE ${p} OR a.body ILIKE ${p} OR ${tags} ILIKE ${p})`,
      );
      scores.push(
        `(CASE WHEN a.title ILIKE ${p} THEN 5 ELSE 0 END
          + CASE WHEN ${tags} ILIKE ${p} THEN 3 ELSE 0 END
          + CASE WHEN a.summary ILIKE ${p} THEN 2 ELSE 0 END
          + CASE WHEN a.body ILIKE ${p} THEN 1 ELSE 0 END)`,
      );
    }
    const forEquipment = `(a."productCodes" && $3::text[] OR a."productGroups" && $4::text[])`;
    const helpful = `(a."portalHelpfulYes" + 1)::float / (a."portalHelpfulYes" + a."portalHelpfulNo" + 2)`;
    const score = [
      ...scores,
      `CASE WHEN ${forEquipment} THEN 4 ELSE 0 END`,
      helpful,
    ].join(' + ');
    const rows = await this.prisma.$queryRawUnsafe<PortalRow[]>(
      `SELECT a.id, a."articleNo", a.title, a.summary, a."categoryId", a.tags,
              a."productCodes", a."productGroups", a."publishedAt", a."updatedAt",
              a."portalHelpfulYes", a."portalHelpfulNo",
              ${forEquipment} AS for_equipment, (${score})::float AS score
       FROM kb_articles a
       WHERE ${where.join(' AND ')}
       ORDER BY score DESC, a."publishedAt" DESC NULLS LAST
       LIMIT ${Math.min(Math.max(limit, 1), 100)}`,
      ...params,
    );
    const categories = await this.categoryNames(viewer.companyId);
    return {
      terms,
      items: rows.map((r) => ({
        id: r.id,
        articleNo: r.articleNo,
        title: r.title,
        summary: r.summary,
        category: r.categoryId ? (categories.get(r.categoryId) ?? null) : null,
        tags: r.tags,
        forYourEquipment: r.for_equipment,
        publishedAt: r.publishedAt,
        helpfulPct:
          r.portalHelpfulYes + r.portalHelpfulNo
            ? Math.round(
                (100 * r.portalHelpfulYes) /
                  (r.portalHelpfulYes + r.portalHelpfulNo),
              )
            : null,
      })),
    };
  }

  /** One article (counted as a Portal view), with its files and my vote. */
  async articleForCustomer(viewer: KbPortalViewer, id: string) {
    const row = await this.readable(viewer, id);
    await this.prisma.kbArticle.update({
      where: { id },
      data: { portalViews: { increment: 1 } },
    });
    const [files, mine, categories] = await Promise.all([
      this.prisma.kbArticleFile.findMany({
        where: { articleId: id, deletedAt: null },
        orderBy: { uploadedAt: 'asc' },
        select: { id: true, fileName: true, mimeType: true, sizeBytes: true },
      }),
      this.prisma.kbPortalRating.findUnique({
        where: {
          articleId_contactId: { articleId: id, contactId: viewer.contactId },
        },
      }),
      this.categoryNames(viewer.companyId),
    ]);
    return {
      id: row.id,
      articleNo: row.articleNo,
      title: row.title,
      summary: row.summary,
      body: row.body,
      category: row.categoryId
        ? (categories.get(row.categoryId) ?? null)
        : null,
      tags: row.tags,
      publishedAt: row.publishedAt,
      files: files.map((f) => ({
        ...f,
        url: `kb/articles/${id}/files/${f.id}`,
      })),
      myVote: mine ? mine.helpful : null,
    };
  }

  async fileForCustomer(
    viewer: KbPortalViewer,
    id: string,
    fileId: string,
  ): Promise<{ stream: Readable; fileName: string; mimeType: string }> {
    await this.readable(viewer, id);
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

  /** The contact's vote (latest wins); the Portal's own tally. */
  async rateForCustomer(viewer: KbPortalViewer, id: string, helpful: boolean) {
    await this.readable(viewer, id);
    await this.prisma.$transaction(async (tx) => {
      await tx.kbPortalRating.upsert({
        where: {
          articleId_contactId: { articleId: id, contactId: viewer.contactId },
        },
        create: { articleId: id, contactId: viewer.contactId, helpful },
        update: { helpful },
      });
      const [yes, no] = await Promise.all([
        tx.kbPortalRating.count({ where: { articleId: id, helpful: true } }),
        tx.kbPortalRating.count({ where: { articleId: id, helpful: false } }),
      ]);
      await tx.kbArticle.update({
        where: { id },
        data: { portalHelpfulYes: yes, portalHelpfulNo: no },
      });
    });
    return { id, myVote: helpful };
  }

  // --- helpers ----------------------------------------------------------------

  private async readable(viewer: KbPortalViewer, id: string) {
    const row = await this.prisma.kbArticle.findFirst({
      where: {
        id,
        companyId: viewer.companyId,
        status: 'published',
        OR: [
          { audience: 'customers' },
          { audience: 'selected', customerIds: { has: viewer.customerId } },
        ],
      },
    });
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบบทความที่ระบุ');
    return row;
  }

  /** The items and SAP item groups of the customer's installed base. */
  private async installedProducts(viewer: KbPortalViewer) {
    const assets = await this.prisma.serviceAsset.findMany({
      where: {
        companyId: viewer.companyId,
        customerId: viewer.customerId,
        status: 'active',
        productCode: { not: null },
      },
      select: { productCode: true },
    });
    const codes = [...new Set(assets.map((a) => a.productCode!))];
    const groups = codes.length
      ? await this.prisma.product.findMany({
          where: {
            companyId: viewer.companyId,
            code: { in: codes },
            groupCode: { not: null },
          },
          select: { groupCode: true },
          distinct: ['groupCode'],
        })
      : [];
    return { codes, groups: groups.map((g) => g.groupCode!) };
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
}
