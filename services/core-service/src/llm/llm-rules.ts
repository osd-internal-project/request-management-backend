/**
 * CD-275 — the LLM Gateway's arithmetic: which model a task uses, how much
 * of its quota is gone, and what a call is estimated to cost. Pure.
 */
import type { LlmKind } from './llm-tasks';
import type { LlmUsage } from './llm-client';

export interface Defaults {
  chatModel: string;
  embedModel: string;
}

/** The company's setting wins; otherwise the default for the task's kind. */
export function modelFor(
  kind: LlmKind,
  setting: { model: string | null } | null,
  defaults: Defaults,
): string {
  return (
    setting?.model?.trim() ||
    (kind === 'embed' ? defaults.embedModel : defaults.chatModel)
  );
}

/** The Bangkok month a moment falls in, as UTC bounds [start, end). */
export function monthBounds(now: Date): { start: Date; end: Date } {
  const bkk = new Date(now.getTime() + 7 * 3_600_000);
  const y = bkk.getUTCFullYear();
  const m = bkk.getUTCMonth();
  return {
    start: new Date(Date.UTC(y, m, 1) - 7 * 3_600_000),
    end: new Date(Date.UTC(y, m + 1, 1) - 7 * 3_600_000),
  };
}

/** Over quota: a quota is set and this month's tokens have reached it. */
export function quotaReached(used: number, quota: number | null): boolean {
  return quota !== null && used >= quota;
}

/** Share of the quota used (0–1+), null when unlimited. */
export function quotaShare(used: number, quota: number | null): number | null {
  if (quota === null || quota <= 0) return null;
  return Math.round((used / quota) * 1000) / 1000;
}

/** Baht, from the model's price per 1,000 tokens; null when it has no price. */
export function costEstimate(
  usage: LlmUsage,
  price: { inputPer1k: number; outputPer1k: number } | null,
): number | null {
  if (!price) return null;
  const cost =
    (usage.promptTokens / 1000) * price.inputPer1k +
    (usage.completionTokens / 1000) * price.outputPer1k;
  return Math.round(cost * 10000) / 10000;
}
