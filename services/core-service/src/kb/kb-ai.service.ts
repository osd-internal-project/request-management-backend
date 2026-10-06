import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppError, hasPermission, Principal } from '@request-management/share';
import { backgroundTick } from '../common/background-tick';
import { CustomerRepository } from '../crm/customer.repository';
import {
  KbAiCitationRepository,
  KbAiQueryRepository,
  KbAiSearchRepository,
} from './kb-ai.repositories';
import { searchTerms } from './kb-rules';
import { byRank, matchFields } from './kb-semantic-rank';
import { KbSemanticService } from './kb-semantic.service';

export const AI_CHANNELS = ['ai_care', 'ai_smart'] as const;
export type AiChannel = (typeof AI_CHANNELS)[number];
const DEFAULT_RETENTION_DAYS = 180;
const DEFAULT_PURGE_INTERVAL_MS = 6 * 3_600_000;
const MAX_TEXT = 4000;

interface QueryRow {
  id: string;
  companyId: string;
  channel: string;
  conversationRef: string | null;
  customerId: string | null;
  question: string | null;
  results: unknown;
  outcome: string;
  answer: string | null;
  answeredAt: Date | null;
  textPurgedAt: Date | null;
  createdAt: Date;
}

/**
 * CD-265 ช่องทางให้ AI ดึงความรู้ไปตอบ (part of CD-22 KBMS) — AI CARE and AI
 * SMART, which talk to customers, read the knowledge base through
 * external-service with a robot key (`integration.kb.read`):
 *
 * - they search published articles meant for customers — every customer,
 *   or the customer in the conversation (by code) — never internal ones,
 *   each with the version read;
 * - every search is kept: the channel, the question, what came back;
 * - they then report what they answered and which of those articles it
 *   cites, or that they could not answer (the gaps of CD-266);
 * - the question and answer texts are cleared after `kb.aiRetentionDays`
 *   (180); which articles were cited and the outcome stay, for the figures.
 *
 * Knowledge owners read the log (`kb.article.manage`).
 */
@Injectable()
export class KbAiService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KbAiService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly queries: KbAiQueryRepository,
    private readonly citations: KbAiCitationRepository,
    private readonly searcher: KbAiSearchRepository,
    private readonly customers: CustomerRepository,
    private readonly config: ConfigService,
    private readonly semantic: KbSemanticService,
  ) {}

  onModuleInit(): void {
    const interval =
      this.config.get<number>('kb.aiPurgeIntervalMs') ??
      DEFAULT_PURGE_INTERVAL_MS;
    if (interval <= 0) return;
    this.timer = setInterval(
      backgroundTick(this.logger, 'CD-265 AI log retention', () =>
        this.purge(),
      ),
      interval,
    );
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // --- the AI channels ------------------------------------------------------------

  async search(
    companyId: string,
    input: {
      question: string;
      channel: AiChannel;
      customerCode?: string;
      conversationRef?: string;
      limit?: number;
    },
  ) {
    const question = input.question.trim().slice(0, MAX_TEXT);
    if (!question) invalid('ต้องระบุคำถาม');
    const customerId = input.customerCode
      ? await this.customerId(companyId, input.customerCode)
      : null;
    // CD-267 — by words and by meaning
    const limit = Math.min(Math.max(Math.trunc(input.limit ?? 5), 1), 10);
    const meaning = await this.semantic.search(companyId, null, question, 10);
    const rows = byRank(
      await this.searcher.search(
        companyId,
        customerId,
        searchTerms(question),
        limit,
        [...(meaning?.keys() ?? [])],
      ),
      meaning,
      limit,
    );
    const query = (await this.queries.create({
      data: {
        companyId,
        channel: input.channel,
        conversationRef: input.conversationRef?.trim().slice(0, 200) || null,
        customerId,
        question,
        results: rows.map((r) => ({ articleId: r.id, version: r.version })),
      },
    })) as { id: string };
    return {
      queryId: query.id,
      articles: rows.map((r) => ({
        id: r.id,
        articleNo: r.articleNo,
        version: r.version,
        title: r.title,
        summary: r.summary,
        body: r.body,
        tags: r.tags,
        productCodes: r.productCodes,
        ...matchFields(r, meaning),
      })),
    };
  }

  /** What the AI answered and which of the returned articles it cites. */
  async answer(
    companyId: string,
    queryId: string,
    input: {
      outcome: 'answered' | 'unanswered';
      answer?: string;
      citedArticleIds?: string[];
    },
  ) {
    const query = (await this.queries.findFirst({
      where: { id: queryId, companyId },
    })) as QueryRow | null;
    if (!query) throw new AppError('NOT_FOUND', 'ไม่พบการค้นที่ระบุ');
    if (query.outcome !== 'pending')
      throw new AppError('CONFLICT', 'บันทึกคำตอบของการค้นนี้ไปแล้ว');
    const returned = resultsOf(query.results);
    const cited = [...new Set(input.citedArticleIds ?? [])];
    const unknown = cited.filter(
      (id) => !returned.some((r) => r.articleId === id),
    );
    if (unknown.length) invalid('อ้างอิงได้เฉพาะบทความที่การค้นนี้ส่งกลับไป');
    if (input.outcome === 'answered' && !cited.length)
      invalid(
        'คำตอบต้องอ้างอิงบทความอย่างน้อยหนึ่งบทความ หรือบันทึกว่าตอบไม่ได้',
      );
    if (input.outcome === 'unanswered' && cited.length)
      invalid('ตอบไม่ได้ต้องไม่อ้างอิงบทความ');
    await this.queries.update({
      where: { id: queryId },
      data: {
        outcome: input.outcome,
        answer: input.answer?.trim().slice(0, MAX_TEXT) || null,
        answeredAt: new Date(),
      },
    });
    if (cited.length) {
      await this.citations.createMany({
        data: cited.map((articleId) => ({
          queryId,
          articleId,
          version: returned.find((r) => r.articleId === articleId)!.version,
        })),
      });
    }
    return { queryId, outcome: input.outcome, cited: cited.length };
  }

  // --- knowledge owners -----------------------------------------------------------

  async log(
    actor: Principal,
    filter: { outcome?: string; channel?: string; articleId?: string },
  ) {
    if (!hasPermission(actor, 'kb.article.manage'))
      throw new AppError('FORBIDDEN', 'ดูบันทึก AI ได้เฉพาะผู้ดูแลคลังความรู้');
    const citedIn = filter.articleId
      ? ((await this.citations.findMany({
          where: { articleId: filter.articleId },
          select: { queryId: true },
          take: 500,
        })) as { queryId: string }[])
      : null;
    const rows = (await this.queries.findMany({
      where: {
        companyId: actor.activeCompanyId,
        ...(filter.outcome ? { outcome: filter.outcome } : {}),
        ...(filter.channel ? { channel: filter.channel } : {}),
        ...(citedIn ? { id: { in: citedIn.map((c) => c.queryId) } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    })) as QueryRow[];
    const cites = (await this.citations.findMany({
      where: { queryId: { in: rows.map((r) => r.id) } },
    })) as { queryId: string; articleId: string; version: number }[];
    return {
      retentionDays: this.retentionDays(),
      items: rows.map((r) => ({
        id: r.id,
        channel: r.channel,
        conversationRef: r.conversationRef,
        question: r.question,
        answer: r.answer,
        outcome: r.outcome,
        createdAt: r.createdAt,
        answeredAt: r.answeredAt,
        textPurged: !!r.textPurgedAt,
        returned: resultsOf(r.results),
        cited: cites
          .filter((c) => c.queryId === r.id)
          .map((c) => ({ articleId: c.articleId, version: c.version })),
      })),
    };
  }

  /** How often AI answers cited an article (for the article page). */
  citationCount(articleId: string) {
    return this.citations.count({ where: { articleId } });
  }

  /** Clear question and answer texts older than the retention period. */
  async purge(now: Date = new Date()) {
    const before = new Date(now.getTime() - this.retentionDays() * 86_400_000);
    const done = await this.queries.updateMany({
      where: { createdAt: { lt: before }, textPurgedAt: null },
      data: {
        question: null,
        answer: null,
        conversationRef: null,
        textPurgedAt: now,
      },
    });
    return { purged: done.count };
  }

  // --- helpers ----------------------------------------------------------------

  private retentionDays() {
    return (
      this.config.get<number>('kb.aiRetentionDays') ?? DEFAULT_RETENTION_DAYS
    );
  }

  private async customerId(companyId: string, code: string) {
    const row = (await this.customers.findFirst({
      where: { companyId, customerCode: code.trim() },
      select: { id: true },
    })) as { id: string } | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบลูกค้าตามรหัสที่ระบุ');
    return row.id;
  }
}

function resultsOf(value: unknown): { articleId: string; version: number }[] {
  return Array.isArray(value)
    ? (value as { articleId: string; version: number }[])
    : [];
}

function invalid(reason: string): never {
  throw new AppError('VALIDATION_FAILED', reason, [{ field: 'body', reason }]);
}
