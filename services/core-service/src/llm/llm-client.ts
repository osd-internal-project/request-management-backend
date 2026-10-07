/**
 * CD-275 — the one doorway to language models: the company's LLM Gateway.
 * No AI feature calls a model provider directly; they call `LlmService`, which
 * calls this. OpenAI-compatible (`/v1/chat/completions`, `/v1/embeddings`),
 * which is what LiteLLM-style gateways expose (user decision 6 ต.ค. 2569);
 * a mock stands in locally and in tests (`LLM_MODE=mock`).
 */

export const LLM_CLIENT = Symbol('LLM_CLIENT');

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  /** Who it is for — passed on so the gateway's own logs can tell callers apart. */
  user?: string;
}

export interface ChatResult {
  text: string;
  model: string;
  usage: LlmUsage;
}

export interface EmbedRequest {
  model: string;
  input: string[];
  user?: string;
}

export interface EmbedResult {
  vectors: number[][];
  model: string;
  usage: LlmUsage;
}

export interface LlmClient {
  readonly mode: 'mock' | 'gateway';
  chat(request: ChatRequest): Promise<ChatResult>;
  embed(request: EmbedRequest): Promise<EmbedResult>;
}
