import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppError } from '@request-management/share';
import {
  LLM_CLIENT,
  type ChatMessage,
  type LlmClient,
  type LlmUsage,
} from './llm-client';
import {
  costEstimate,
  modelFor,
  monthBounds,
  quotaReached,
  type Defaults,
} from './llm-rules';
import { taskSpec, type LlmKind } from './llm-tasks';
import {
  LlmCallRepository,
  LlmModelPriceRepository,
  LlmTaskSettingRepository,
} from './llm.repositories';

export interface LlmCaller {
  companyId: string;
  /** The person it is for, when there is one (null for background work). */
  userId?: string | null;
  task: string;
}

const NO_USAGE: LlmUsage = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
};

/**
 * CD-275 — what every AI feature calls (never the client, never a provider):
 * the task picks the model (company setting, else the default), its monthly
 * token quota is checked first, the call goes through the gateway, and every
 * call — refused, failed or done — is logged with its tokens and estimated
 * cost. Prompt and answer text are not stored.
 */
@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);

  constructor(
    @Inject(LLM_CLIENT) private readonly client: LlmClient,
    private readonly settings: LlmTaskSettingRepository,
    private readonly prices: LlmModelPriceRepository,
    private readonly calls: LlmCallRepository,
    private readonly config: ConfigService,
  ) {}

  get mode() {
    return this.client.mode;
  }

  defaults(): Defaults {
    return {
      chatModel:
        this.config.get<string>('llm.defaultChatModel') ?? 'default-chat',
      embedModel:
        this.config.get<string>('llm.defaultEmbedModel') ?? 'default-embed',
    };
  }

  async chat(
    caller: LlmCaller,
    messages: ChatMessage[],
    options: { maxTokens?: number; temperature?: number } = {},
  ) {
    const route = await this.route(caller, 'chat');
    return this.run(caller, route, 'chat', async () => {
      const result = await this.client.chat({
        model: route.model,
        messages,
        ...options,
        ...(caller.userId ? { user: caller.userId } : {}),
      });
      return { value: result.text, model: result.model, usage: result.usage };
    }).then(({ value, model, usage }) => ({ text: value, model, usage }));
  }

  async embed(caller: LlmCaller, texts: string[]) {
    const route = await this.route(caller, 'embed');
    if (!texts.length)
      return { vectors: [] as number[][], model: route.model, usage: NO_USAGE };
    return this.run(caller, route, 'embed', async () => {
      const result = await this.client.embed({
        model: route.model,
        input: texts,
        ...(caller.userId ? { user: caller.userId } : {}),
      });
      return {
        value: result.vectors,
        model: result.model,
        usage: result.usage,
      };
    }).then(({ value, model, usage }) => ({ vectors: value, model, usage }));
  }

  /** This month's tokens for a company's task. */
  async usedThisMonth(companyId: string, task: string, now = new Date()) {
    const { start, end } = monthBounds(now);
    const rows = (await this.calls.findMany({
      where: { companyId, task, createdAt: { gte: start, lt: end } },
      select: { totalTokens: true },
    })) as { totalTokens: number }[];
    return rows.reduce((sum, row) => sum + row.totalTokens, 0);
  }

  private async route(caller: LlmCaller, kind: LlmKind) {
    const spec = taskSpec(caller.task);
    if (!spec || spec.kind !== kind) {
      throw new AppError(
        'VALIDATION_FAILED',
        `งาน AI "${caller.task}" ไม่อยู่ในรายการ (${kind})`,
      );
    }
    const setting = (await this.settings.findFirst({
      where: { companyId: caller.companyId, task: caller.task },
    })) as {
      model: string | null;
      monthlyTokenQuota: number | null;
      enabled: boolean;
    } | null;
    return {
      model: modelFor(kind, setting, this.defaults()),
      quota: setting?.monthlyTokenQuota ?? null,
      enabled: setting?.enabled ?? true,
    };
  }

  private async run<T>(
    caller: LlmCaller,
    route: { model: string; quota: number | null; enabled: boolean },
    kind: LlmKind,
    call: () => Promise<{ value: T; model: string; usage: LlmUsage }>,
  ) {
    if (!route.enabled) {
      await this.log(caller, kind, route.model, NO_USAGE, 0, 'disabled', null);
      throw new AppError(
        'LLM_TASK_DISABLED',
        `งาน AI "${caller.task}" ถูกปิดอยู่`,
      );
    }
    if (route.quota !== null) {
      const used = await this.usedThisMonth(caller.companyId, caller.task);
      if (quotaReached(used, route.quota)) {
        await this.log(caller, kind, route.model, NO_USAGE, 0, 'quota', null);
        throw new AppError(
          'LLM_QUOTA_EXCEEDED',
          `งาน AI "${caller.task}" ใช้ครบโควตาเดือนนี้แล้ว (${route.quota.toLocaleString('en-US')} token)`,
        );
      }
    }
    const started = Date.now();
    try {
      const result = await call();
      await this.log(
        caller,
        kind,
        result.model,
        result.usage,
        Date.now() - started,
        'ok',
        null,
      );
      return result;
    } catch (error) {
      await this.log(
        caller,
        kind,
        route.model,
        NO_USAGE,
        Date.now() - started,
        'error',
        error instanceof Error ? error.message.slice(0, 500) : String(error),
      );
      throw error;
    }
  }

  private async log(
    caller: LlmCaller,
    kind: LlmKind,
    model: string,
    usage: LlmUsage,
    durationMs: number,
    status: 'ok' | 'error' | 'quota' | 'disabled',
    error: string | null,
  ) {
    try {
      const price = (await this.prices.findFirst({
        where: { companyId: caller.companyId, model },
        select: { inputPer1k: true, outputPer1k: true },
      })) as { inputPer1k: unknown; outputPer1k: unknown } | null;
      await this.calls.create({
        data: {
          companyId: caller.companyId,
          userId: caller.userId ?? null,
          task: caller.task,
          kind,
          model,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
          costEstimate: costEstimate(
            usage,
            price
              ? {
                  inputPer1k: Number(price.inputPer1k),
                  outputPer1k: Number(price.outputPer1k),
                }
              : null,
          ),
          durationMs,
          status,
          error,
        },
      });
    } catch (logError) {
      // The log never takes the answer down with it.
      this.logger.warn(`LLM call log failed: ${String(logError)}`);
    }
  }
}
