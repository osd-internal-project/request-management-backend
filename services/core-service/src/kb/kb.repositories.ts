import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  type TQueryClient,
} from '@request-management/share';

/**
 * CD-263 — knowledge articles, for services written after AGENTS.md's
 * repository rule was pointed out (the earlier KB services still read
 * through PrismaService and move here separately).
 */
@Injectable()
export class KbArticleRepository extends BaseRepository<
  PrismaService['kbArticle']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.kbArticle;
  }
}

/** CD-264 — the field-knowledge inbox (service jobs, Pre-Sales answers). */
@Injectable()
export class KbCandidateRepository extends BaseRepository<
  PrismaService['kbCandidate']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.kbCandidate;
  }
}

/** CD-266 — gaps in the knowledge base. */
@Injectable()
export class KbGapRepository extends BaseRepository<PrismaService['kbGap']> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.kbGap;
  }
}

/**
 * CD-266 — monthly figures (raw SQL; every value a parameter). Timestamps
 * are stored as UTC without a zone, so a Bangkok month is
 * `(col AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Bangkok'`.
 */
@Injectable()
export class KbGapStatsRepository {
  constructor(private readonly prisma: PrismaService) {}

  aiMonthly(companyId: string, since: Date) {
    return this.prisma.$queryRawUnsafe<
      {
        month: string;
        channel: string;
        outcome: string;
        handedOff: boolean;
        n: number;
      }[]
    >(
      `SELECT to_char(("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM') AS month,
              channel, outcome, ("handedOffAt" IS NOT NULL) AS "handedOff",
              count(*)::int AS n
       FROM kb_ai_queries
       WHERE "companyId" = $1 AND "createdAt" >= $2
       GROUP BY 1, 2, 3, 4 ORDER BY 1`,
      companyId,
      since,
    );
  }

  gapsMonthly(companyId: string, since: Date) {
    return this.prisma.$queryRawUnsafe<
      { month: string; opened: number; resolved: number }[]
    >(
      `WITH o AS (
         SELECT to_char(("firstSeenAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM') AS month, count(*)::int AS n
         FROM kb_gaps WHERE "companyId" = $1 AND "firstSeenAt" >= $2 AND kind <> 'search_miss'
         GROUP BY 1),
       r AS (
         SELECT to_char(("resolvedAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM') AS month, count(*)::int AS n
         FROM kb_gaps WHERE "companyId" = $1 AND "resolvedAt" >= $2 GROUP BY 1)
       SELECT COALESCE(o.month, r.month) AS month, COALESCE(o.n, 0) AS opened, COALESCE(r.n, 0) AS resolved
       FROM o FULL JOIN r ON r.month = o.month ORDER BY 1`,
      companyId,
      since,
    );
  }
}

export interface ChunkVectorRow {
  articleId: string;
  seq: number;
  heading: string | null;
  vector: number[];
}

export interface EmbedPendingRow {
  id: string;
  companyId: string;
  version: number;
  title: string;
  summary: string | null;
  body: string;
  tags: string[];
}

/**
 * CD-267 — passages of published articles and their embeddings. A
 * republished article's passages are replaced at once, never half-written.
 */
@Injectable()
export class KbChunkRepository extends BaseRepository<
  PrismaService['kbChunk']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.kbChunk;
  }

  async replaceForArticle(
    articleId: string,
    rows: {
      companyId: string;
      articleVersion: number;
      seq: number;
      heading: string | null;
      text: string;
      hash: string;
      model: string;
      vector: number[];
    }[],
  ) {
    await this.prisma.$transaction([
      this.prisma.kbChunk.deleteMany({ where: { articleId } }),
      this.prisma.kbChunk.createMany({
        data: rows.map((row) => ({ ...row, articleId })),
      }),
    ]);
  }

  /** Companies with published articles. */
  async companies() {
    const rows = await this.prisma.$queryRawUnsafe<{ companyId: string }[]>(
      `SELECT DISTINCT "companyId" FROM kb_articles WHERE status = 'published'`,
    );
    return rows.map((r) => r.companyId);
  }

  /** Published articles with no passages of this version and model yet. */
  pending(companyId: string, model: string, limit: number) {
    return this.prisma.$queryRawUnsafe<EmbedPendingRow[]>(
      `SELECT a.id, a."companyId", a.version, a.title, a.summary, a.body, a.tags
       FROM kb_articles a
       WHERE a."companyId" = $1 AND a.status = 'published'
         AND NOT EXISTS (SELECT 1 FROM kb_chunks c
                         WHERE c."articleId" = a.id AND c."articleVersion" = a.version
                           AND c.model = $2)
       ORDER BY a."publishedAt" DESC NULLS LAST
       LIMIT ${Math.max(1, Math.trunc(limit))}`,
      companyId,
      model,
    );
  }

  /** Passages of articles no longer published — never searched again. */
  dropUnpublished() {
    return this.prisma.$executeRawUnsafe(
      `DELETE FROM kb_chunks c WHERE NOT EXISTS (
         SELECT 1 FROM kb_articles a WHERE a.id = c."articleId" AND a.status = 'published')`,
    );
  }

  /** Count and newest passage — when it changes, the cached vectors are old. */
  async stamp(companyId: string, model: string) {
    const [row] = await this.prisma.$queryRawUnsafe<
      { n: number; latest: Date | null }[]
    >(
      `SELECT count(*)::int AS n, max("createdAt") AS latest
       FROM kb_chunks WHERE "companyId" = $1 AND model = $2`,
      companyId,
      model,
    );
    return `${row?.n ?? 0}:${row?.latest?.toISOString() ?? ''}`;
  }

  vectors(companyId: string, model: string) {
    return this.prisma.$queryRawUnsafe<ChunkVectorRow[]>(
      `SELECT "articleId", seq, heading, vector
       FROM kb_chunks WHERE "companyId" = $1 AND model = $2`,
      companyId,
      model,
    );
  }

  /** Published articles, and how many have passages of this model. */
  async coverage(companyId: string, model: string) {
    const [row] = await this.prisma.$queryRawUnsafe<
      { published: number; indexed: number; passages: number }[]
    >(
      `SELECT
         (SELECT count(*)::int FROM kb_articles
          WHERE "companyId" = $1 AND status = 'published') AS published,
         (SELECT count(DISTINCT a.id)::int FROM kb_articles a
          JOIN kb_chunks c ON c."articleId" = a.id AND c."articleVersion" = a.version
           AND c.model = $2
          WHERE a."companyId" = $1 AND a.status = 'published') AS indexed,
         (SELECT count(*)::int FROM kb_chunks
          WHERE "companyId" = $1 AND model = $2) AS passages`,
      companyId,
      model,
    );
    return row ?? { published: 0, indexed: 0, passages: 0 };
  }
}
