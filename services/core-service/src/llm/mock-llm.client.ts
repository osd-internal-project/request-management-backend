import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type {
  ChatRequest,
  ChatResult,
  EmbedRequest,
  EmbedResult,
  LlmClient,
} from './llm-client';

/** Roughly a token per four characters — enough for usage figures in a mock. */
export const roughTokens = (text: string) =>
  Math.max(1, Math.ceil(text.length / 4));

/** Dimensions of a mock embedding. */
export const MOCK_DIMENSIONS = 32;

/**
 * CD-275 — the LLM Gateway stand-in (`LLM_MODE=mock`): no network. Chat says
 * it is a mock and repeats the gist of the last message; embeddings are
 * deterministic unit vectors from a hash of the text, so the same text always
 * lands on the same point and different texts on different ones.
 */
@Injectable()
export class MockLlmClient implements LlmClient {
  readonly mode = 'mock' as const;

  chat(request: ChatRequest): Promise<ChatResult> {
    const last = [...request.messages].reverse().find((m) => m.role === 'user');
    const gist = (last?.content ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200);
    const text = `[mock ${request.model}] ${gist}`;
    const promptTokens = request.messages.reduce(
      (sum, message) => sum + roughTokens(message.content),
      0,
    );
    const completionTokens = roughTokens(text);
    return Promise.resolve({
      text,
      model: request.model,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
    });
  }

  embed(request: EmbedRequest): Promise<EmbedResult> {
    const vectors = request.input.map(mockVector);
    const promptTokens = request.input.reduce(
      (sum, text) => sum + roughTokens(text),
      0,
    );
    return Promise.resolve({
      vectors,
      model: request.model,
      usage: { promptTokens, completionTokens: 0, totalTokens: promptTokens },
    });
  }
}

export function mockVector(text: string): number[] {
  const bytes = createHash('sha256').update(text.trim().toLowerCase()).digest();
  const raw = Array.from(
    { length: MOCK_DIMENSIONS },
    (_, i) => bytes[i] - 127.5,
  );
  const norm = Math.sqrt(raw.reduce((sum, v) => sum + v * v, 0)) || 1;
  return raw.map((v) => Math.round((v / norm) * 1e6) / 1e6);
}
