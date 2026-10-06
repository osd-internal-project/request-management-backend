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
      { month: string; channel: string; outcome: string; n: number }[]
    >(
      `SELECT to_char(("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM') AS month,
              channel, outcome, count(*)::int AS n
       FROM kb_ai_queries
       WHERE "companyId" = $1 AND "createdAt" >= $2
       GROUP BY 1, 2, 3 ORDER BY 1`,
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
