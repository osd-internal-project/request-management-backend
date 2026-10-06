import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  type TQueryClient,
} from '@request-management/share';
import { likePattern } from './kb-rules';

/** CD-265 — what an AI channel searched, got and answered with. */
@Injectable()
export class KbAiQueryRepository extends BaseRepository<
  PrismaService['kbAiQuery']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.kbAiQuery;
  }
}

/** CD-265 — the articles an AI answer cited. */
@Injectable()
export class KbAiCitationRepository extends BaseRepository<
  PrismaService['kbAiCitation']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.kbAiCitation;
  }
}

export interface AiSearchRow {
  id: string;
  articleNo: string;
  version: number;
  title: string;
  summary: string | null;
  body: string;
  tags: string[];
  productCodes: string[];
  score: number;
}

/**
 * CD-265 — the article search an AI channel may run: published articles
 * meant for customers — every customer, or the one in the conversation —
 * never internal ones. Every value is a parameter.
 */
@Injectable()
export class KbAiSearchRepository {
  constructor(private readonly prisma: PrismaService) {}

  search(
    companyId: string,
    customerId: string | null,
    terms: string[],
    limit: number,
  ) {
    const params: unknown[] = [companyId, customerId];
    const where = [
      `a."companyId" = $1`,
      `a.status = 'published'`,
      `(a.audience = 'customers' OR (a.audience = 'selected' AND $2::text IS NOT NULL AND $2::text = ANY(a."customerIds")))`,
    ];
    const scores: string[] = [];
    for (const term of terms) {
      params.push(likePattern(term));
      const p = `$${params.length}`;
      const tags = `array_to_string(a.tags, ' ')`;
      const codes = `array_to_string(a."productCodes", ' ')`;
      where.push(
        `(a.title ILIKE ${p} OR a.summary ILIKE ${p} OR a.body ILIKE ${p} OR ${tags} ILIKE ${p} OR ${codes} ILIKE ${p})`,
      );
      scores.push(
        `(CASE WHEN a.title ILIKE ${p} THEN 5 ELSE 0 END
          + CASE WHEN ${tags} ILIKE ${p} OR ${codes} ILIKE ${p} THEN 3 ELSE 0 END
          + CASE WHEN a.summary ILIKE ${p} THEN 2 ELSE 0 END
          + CASE WHEN a.body ILIKE ${p} THEN 1 ELSE 0 END)`,
      );
    }
    const helpful = `(a."helpfulYes" + a."portalHelpfulYes" + 1)::float
      / (a."helpfulYes" + a."helpfulNo" + a."portalHelpfulYes" + a."portalHelpfulNo" + 2)`;
    const score = [...scores, `2 * ${helpful}`].join(' + ');
    return this.prisma.$queryRawUnsafe<AiSearchRow[]>(
      `SELECT a.id, a."articleNo", a.version, a.title, a.summary, a.body, a.tags,
              a."productCodes", (${score})::float AS score
       FROM kb_articles a
       WHERE ${where.join(' AND ')}
       ORDER BY score DESC, a."publishedAt" DESC NULLS LAST
       LIMIT ${Math.min(Math.max(Math.trunc(limit), 1), 10)}`,
      ...params,
    );
  }
}
