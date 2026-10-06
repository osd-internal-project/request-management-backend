import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppError } from '@request-management/share';
import type {
  ChatRequest,
  ChatResult,
  EmbedRequest,
  EmbedResult,
  LlmClient,
  LlmUsage,
} from './llm-client';

export interface LlmGatewaySettings {
  url?: string;
  apiKey?: string;
  timeoutMs?: number;
}

interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

const usageOf = (usage: OpenAiUsage | undefined): LlmUsage => {
  const promptTokens = usage?.prompt_tokens ?? 0;
  const completionTokens = usage?.completion_tokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: usage?.total_tokens ?? promptTokens + completionTokens,
  };
};

/**
 * CD-275 — the company LLM Gateway over HTTP (`LLM_MODE=gateway`),
 * OpenAI-compatible. The key never leaves this class; a gateway that answers
 * with an error or does not answer in time is `UPSTREAM_ERROR`, its message
 * kept short so no prompt text is echoed back to the caller.
 */
@Injectable()
export class GatewayLlmClient implements LlmClient {
  readonly mode = 'gateway' as const;

  constructor(private readonly config: ConfigService) {}

  static missingSettings(settings: LlmGatewaySettings | undefined): string[] {
    return [
      !settings?.url && 'LLM_GATEWAY_URL',
      !settings?.apiKey && 'LLM_GATEWAY_API_KEY',
    ].filter((name): name is string => Boolean(name));
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    const body = (await this.post('/v1/chat/completions', {
      model: request.model,
      messages: request.messages,
      ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
      ...(request.temperature !== undefined
        ? { temperature: request.temperature }
        : {}),
      ...(request.user ? { user: request.user } : {}),
    })) as {
      model?: string;
      choices?: { message?: { content?: string } }[];
      usage?: OpenAiUsage;
    };
    return {
      text: body.choices?.[0]?.message?.content ?? '',
      model: body.model ?? request.model,
      usage: usageOf(body.usage),
    };
  }

  async embed(request: EmbedRequest): Promise<EmbedResult> {
    const body = (await this.post('/v1/embeddings', {
      model: request.model,
      input: request.input,
      ...(request.user ? { user: request.user } : {}),
    })) as {
      model?: string;
      data?: { index?: number; embedding?: number[] }[];
      usage?: OpenAiUsage;
    };
    const rows = [...(body.data ?? [])].sort(
      (a, b) => (a.index ?? 0) - (b.index ?? 0),
    );
    return {
      vectors: rows.map((row) => row.embedding ?? []),
      model: body.model ?? request.model,
      usage: usageOf(body.usage),
    };
  }

  private async post(path: string, payload: unknown): Promise<unknown> {
    const settings = this.config.get<LlmGatewaySettings>('llm.gateway') ?? {};
    const base = (settings.url ?? '').replace(/\/$/, '');
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      settings.timeoutMs ?? 60_000,
    );
    try {
      const response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${settings.apiKey ?? ''}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new AppError(
          'UPSTREAM_ERROR',
          `LLM Gateway ตอบ ${response.status}`,
        );
      }
      return await response.json();
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        'UPSTREAM_ERROR',
        controller.signal.aborted
          ? 'LLM Gateway ไม่ตอบในเวลาที่กำหนด'
          : 'ติดต่อ LLM Gateway ไม่ได้',
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
