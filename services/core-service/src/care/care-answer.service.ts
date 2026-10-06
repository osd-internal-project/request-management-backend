import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppError } from '@request-management/share';
import { KbAiService } from '../kb/kb-ai.service';
import { questionTerms } from '../kb/kb-rules';
import { LlmService } from '../llm/llm.service';
import {
  GREETING_TEXT,
  MAX_ARTICLES,
  UNANSWERED_TEXT,
  UNAVAILABLE_TEXT,
  answerPrompt,
  extractiveAnswer,
  readAnswer,
  withSources,
  type AnswerArticle,
  type AnswerAsset,
  type AnswerMessage,
} from './care-answer-rules';

export interface CareAnswer {
  text: string;
  /**
   * answered — from the articles cited · unanswered — no article answered it
   * (said so, a case or a person offered; logged as a gap) · unavailable — the
   * gateway is off or down · prompt — nothing to search by (a greeting).
   */
  kind: 'answered' | 'unanswered' | 'unavailable' | 'prompt';
  answered: boolean;
  articles: {
    id: string;
    articleNo: string;
    title: string;
    link: string | null;
  }[];
  kbQueryId: string | null;
}

/**
 * CD-281 (CD-23 AI CARE) — the answer AI CARE sends: the customer's question
 * searched in the knowledge base (customer-facing articles only, plus those
 * for this customer once verified — CD-265/267), the articles handed to the
 * model through the LLM Gateway (task `care.reply`), and the answer kept only
 * if it cites them. Every search and its outcome are logged as CD-265 does,
 * so an unanswered question becomes a knowledge gap (CD-266). Each cited
 * article comes with its Customer Portal link.
 */
@Injectable()
export class CareAnswerService {
  private readonly logger = new Logger(CareAnswerService.name);

  constructor(
    private readonly kb: KbAiService,
    private readonly llm: LlmService,
    private readonly config: ConfigService,
  ) {}

  async answer(input: {
    companyId: string;
    conversationId: string;
    question: string;
    customerCode: string | null;
    customerName: string | null;
    assets: AnswerAsset[];
    history: AnswerMessage[];
  }): Promise<CareAnswer> {
    // a greeting or thanks: ask what it is about, search nothing, log nothing
    if (!questionTerms(input.question).length) {
      return {
        text: GREETING_TEXT,
        kind: 'prompt',
        answered: false,
        articles: [],
        kbQueryId: null,
      };
    }
    const found = await this.kb.search(input.companyId, {
      question: input.question,
      channel: 'ai_care',
      customerCode: input.customerCode ?? undefined,
      conversationRef: input.conversationId,
      limit: MAX_ARTICLES,
    });
    const articles: AnswerArticle[] = found.articles.map((a) => ({
      id: a.id,
      articleNo: a.articleNo,
      title: a.title,
      summary: a.summary,
      body: a.body,
    }));
    const unanswered = async (): Promise<CareAnswer> => {
      await this.kb.answer(input.companyId, found.queryId, {
        outcome: 'unanswered',
      });
      return {
        text: UNANSWERED_TEXT,
        kind: 'unanswered',
        answered: false,
        articles: [],
        kbQueryId: found.queryId,
      };
    };
    if (!articles.length) return unanswered();

    let written: string | null;
    try {
      written = await this.write(input, articles);
    } catch (error) {
      // the gateway is off, over quota or down: not a gap in the knowledge
      const code = error instanceof AppError ? error.code : null;
      this.logger.warn(
        `care.reply failed${code ? ` (${code})` : ''}: ${String(error)}`,
      );
      return {
        text: UNAVAILABLE_TEXT,
        kind: 'unavailable',
        answered: false,
        articles: [],
        kbQueryId: found.queryId,
      };
    }
    const read = readAnswer(written ?? '', articles);
    if (!read.answered) return unanswered();
    await this.kb.answer(input.companyId, found.queryId, {
      outcome: 'answered',
      answer: read.text,
      citedArticleIds: read.cited.map((a) => a.id),
    });
    const link = (id: string) => this.portalLink(id);
    return {
      text: withSources(read.text, read.cited, link),
      kind: 'answered',
      answered: true,
      articles: read.cited.map((a) => ({
        id: a.id,
        articleNo: a.articleNo,
        title: a.title,
        link: link(a.id),
      })),
      kbQueryId: found.queryId,
    };
  }

  private async write(
    input: Parameters<CareAnswerService['answer']>[0],
    articles: AnswerArticle[],
  ) {
    // mock: no model to read the articles — answer from the best one
    if (this.llm.mode === 'mock') return extractiveAnswer(articles);
    const result = await this.llm.chat(
      { companyId: input.companyId, userId: null, task: 'care.reply' },
      answerPrompt({
        question: input.question,
        articles,
        history: input.history,
        customerName: input.customerName,
        assets: input.assets,
      }),
      { maxTokens: 800, temperature: 0.2 },
    );
    return result.text;
  }

  /** The article on the Customer Portal (the customer signs in there first). */
  private portalLink(articleId: string) {
    const base = this.config
      .get<string>('care.publicWebUrl')
      ?.replace(/\/+$/, '');
    return base
      ? `${base}/f/portal?article=${encodeURIComponent(articleId)}`
      : null;
  }
}
