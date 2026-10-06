import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppError } from '@request-management/share';
import { modelFor } from '../llm/llm-rules';
import { LlmService } from '../llm/llm.service';
import { LlmTaskSettingRepository } from '../llm/llm.repositories';
import {
  bestByArticle,
  cosine,
  passagesOf,
  type SemanticHit,
} from './kb-semantic-rules';
import { KbChunkRepository, type EmbedPendingRow } from './kb.repositories';

const TASK = 'kb.embed';
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
/** Articles embedded per company per sweep. */
const BATCH = 20;
/** Passages sent to the gateway in one call. */
const PER_CALL = 32;
/** Cosine below this is not a match (override with KB_SEMANTIC_MIN_SIMILARITY). */
const DEFAULT_MIN_SIMILARITY = 0.35;

interface CachedVectors {
  stamp: string;
  rows: {
    articleId: string;
    seq: number;
    heading: string | null;
    vector: Float32Array;
  }[];
}

export interface SemanticMatch extends SemanticHit {
  /** The passage that matched best (cut to a snippet). */
  passage: string;
}

/**
 * CD-267 — the knowledge base searched by meaning. Published articles are
 * cut into passages and embedded through the LLM Gateway (task `kb.embed`,
 * CD-275) by a sweep; a search embeds the question and ranks passages by
 * cosine, worked out here (pgvector is not on the servers). The vectors of
 * a company are cached and reloaded when its passages change. When the task
 * is off, over quota or the gateway fails, searching by meaning returns
 * nothing and the keyword search carries on alone.
 */
@Injectable()
export class KbSemanticService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KbSemanticService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly cache = new Map<string, CachedVectors>();

  constructor(
    private readonly chunks: KbChunkRepository,
    private readonly llm: LlmService,
    private readonly settings: LlmTaskSettingRepository,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const interval =
      this.config.get<number>('kb.embedIntervalMs') ?? DEFAULT_INTERVAL_MS;
    if (interval <= 0) return;
    this.timer = setInterval(() => {
      void this.sweep().catch((error) =>
        this.logger.warn(`kb embed sweep failed: ${String(error)}`),
      );
    }, interval);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  minSimilarity() {
    const value = Number(this.config.get('kb.semanticMinSimilarity'));
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_MIN_SIMILARITY;
  }

  /** The model the company's `kb.embed` task uses now, and whether it is on. */
  async route(companyId: string) {
    const setting = (await this.settings.findFirst({
      where: { companyId, task: TASK },
    })) as { model: string | null; enabled: boolean } | null;
    return {
      model: modelFor('embed', setting, this.llm.defaults()),
      enabled: setting?.enabled ?? true,
    };
  }

  /**
   * Articles whose passages mean what `text` asks, best first — null when
   * searching by meaning is not possible now (nothing indexed, task off,
   * quota, gateway down).
   */
  async search(
    companyId: string,
    userId: string | null,
    text: string,
    limit = 20,
  ): Promise<Map<string, SemanticMatch> | null> {
    const question = text.trim().slice(0, 2000);
    if (!question) return null;
    const { model, enabled } = await this.route(companyId);
    if (!enabled) return null;
    const cached = await this.vectorsOf(companyId, model);
    if (!cached.rows.length) return null;
    let query: number[];
    try {
      const result = await this.llm.embed({ companyId, userId, task: TASK }, [
        question,
      ]);
      query = result.vectors[0] ?? [];
    } catch (error) {
      this.logger.debug(`semantic search skipped: ${String(error)}`);
      return null;
    }
    const hits = bestByArticle(
      cached.rows.map((row) => ({
        articleId: row.articleId,
        seq: row.seq,
        heading: row.heading,
        similarity: cosine(query, row.vector),
      })),
      this.minSimilarity(),
      limit,
    );
    if (!hits.length) return new Map();
    const passages = (await this.chunks.findMany({
      where: {
        model,
        OR: hits.map((h) => ({ articleId: h.articleId, seq: h.seq })),
      },
      select: { articleId: true, seq: true, text: true },
    })) as { articleId: string; seq: number; text: string }[];
    return new Map(
      hits.map((hit) => {
        const passage =
          passages.find(
            (p) => p.articleId === hit.articleId && p.seq === hit.seq,
          )?.text ?? '';
        return [
          hit.articleId,
          {
            ...hit,
            similarity: Math.round(hit.similarity * 1000) / 1000,
            passage: snippet(passage),
          },
        ];
      }),
    );
  }

  /** Embed what is new or changed, and drop what is no longer published. */
  async sweep(): Promise<{ embedded: number; passages: number }> {
    if (this.running) return { embedded: 0, passages: 0 };
    this.running = true;
    const result = { embedded: 0, passages: 0 };
    try {
      for (const companyId of await this.chunks.companies()) {
        const done = await this.indexCompany(companyId, BATCH);
        result.embedded += done.embedded;
        result.passages += done.passages;
      }
      await this.chunks.dropUnpublished();
    } finally {
      this.running = false;
    }
    return result;
  }

  /** One company now (the "index now" button), up to `limit` articles. */
  async indexCompany(companyId: string, limit = BATCH) {
    const result = { embedded: 0, passages: 0 };
    const { model, enabled } = await this.route(companyId);
    if (!enabled) return result;
    const pending = await this.chunks.pending(companyId, model, limit);
    for (const article of pending) {
      try {
        result.passages += await this.embedArticle(article, model);
        result.embedded += 1;
      } catch (error) {
        const code = error instanceof AppError ? error.code : null;
        this.logger.warn(
          `kb embed ${article.id} failed${code ? ` (${code})` : ''}: ${String(error)}`,
        );
        // over quota or switched off: no point trying the rest now
        if (code === 'LLM_QUOTA_EXCEEDED' || code === 'LLM_TASK_DISABLED')
          break;
      }
    }
    return result;
  }

  /** Coverage of the index for the knowledge owners. */
  async status(companyId: string) {
    const { model, enabled } = await this.route(companyId);
    const coverage = await this.chunks.coverage(companyId, model);
    return {
      mode: this.llm.mode,
      model,
      enabled,
      minSimilarity: this.minSimilarity(),
      ...coverage,
      pending: Math.max(coverage.published - coverage.indexed, 0),
    };
  }

  private async embedArticle(article: EmbedPendingRow, model: string) {
    const passages = passagesOf(article);
    // an unchanged passage keeps its vector
    const known = (await this.chunks.findMany({
      where: { articleId: article.id, model },
      select: { hash: true, vector: true },
    })) as { hash: string; vector: number[] }[];
    const vectors = new Map(known.map((k) => [k.hash, k.vector]));
    const missing = passages.filter((p) => !vectors.has(p.hash));
    for (let i = 0; i < missing.length; i += PER_CALL) {
      const batch = missing.slice(i, i + PER_CALL);
      const result = await this.llm.embed(
        { companyId: article.companyId, userId: null, task: TASK },
        batch.map((p) => p.input),
      );
      batch.forEach((p, j) => vectors.set(p.hash, result.vectors[j] ?? []));
    }
    await this.chunks.replaceForArticle(
      article.id,
      passages.map((p) => ({
        companyId: article.companyId,
        articleVersion: article.version,
        seq: p.seq,
        heading: p.heading,
        text: p.text,
        hash: p.hash,
        model,
        vector: vectors.get(p.hash) ?? [],
      })),
    );
    return missing.length;
  }

  private async vectorsOf(companyId: string, model: string) {
    const key = `${companyId}|${model}`;
    const stamp = await this.chunks.stamp(companyId, model);
    const cached = this.cache.get(key);
    if (cached && cached.stamp === stamp) return cached;
    const rows = await this.chunks.vectors(companyId, model);
    const fresh: CachedVectors = {
      stamp,
      rows: rows
        .filter((r) => r.vector?.length)
        .map((r) => ({
          articleId: r.articleId,
          seq: r.seq,
          heading: r.heading,
          vector: Float32Array.from(r.vector),
        })),
    };
    this.cache.set(key, fresh);
    return fresh;
  }
}

/** A passage cut to about two lines for a result card. */
function snippet(text: string, max = 240) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max).trimEnd()}…` : flat;
}
