import {
  costEstimate,
  modelFor,
  monthBounds,
  quotaReached,
  quotaShare,
} from './llm-rules';
import { MockLlmClient, mockVector, MOCK_DIMENSIONS } from './mock-llm.client';

describe('CD-275 LLM Gateway rules', () => {
  const defaults = { chatModel: 'gpt-chat', embedModel: 'text-embed' };

  it('a task uses the company setting, else the default for its kind', () => {
    expect(modelFor('chat', null, defaults)).toBe('gpt-chat');
    expect(modelFor('embed', { model: null }, defaults)).toBe('text-embed');
    expect(modelFor('chat', { model: ' claude-x ' }, defaults)).toBe(
      'claude-x',
    );
  });

  it('the quota month is the Bangkok month', () => {
    // 31 Oct 20:00 UTC is already 1 Nov in Bangkok
    const { start, end } = monthBounds(new Date('2026-10-31T20:00:00Z'));
    expect(start.toISOString()).toBe('2026-10-31T17:00:00.000Z');
    expect(end.toISOString()).toBe('2026-11-30T17:00:00.000Z');
  });

  it('quota: none means unlimited; reached at the limit', () => {
    expect(quotaReached(1_000_000, null)).toBe(false);
    expect(quotaReached(999, 1000)).toBe(false);
    expect(quotaReached(1000, 1000)).toBe(true);
    expect(quotaShare(250, 1000)).toBe(0.25);
    expect(quotaShare(250, null)).toBeNull();
  });

  it('cost from the price per 1,000 tokens; no price, no estimate', () => {
    expect(
      costEstimate(
        { promptTokens: 2000, completionTokens: 500, totalTokens: 2500 },
        { inputPer1k: 0.1, outputPer1k: 0.4 },
      ),
    ).toBe(0.4);
    expect(
      costEstimate(
        { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        null,
      ),
    ).toBeNull();
  });

  it('the mock is deterministic and needs no network', async () => {
    expect(mockVector('กล้อง')).toEqual(mockVector(' กล้อง '));
    expect(mockVector('กล้อง')).not.toEqual(mockVector('NVR'));
    expect(mockVector('x')).toHaveLength(MOCK_DIMENSIONS);
    const reply = await new MockLlmClient().chat({
      model: 'm',
      messages: [{ role: 'user', content: 'สวัสดี' }],
    });
    expect(reply.text).toBe('[mock m] สวัสดี');
    expect(reply.usage.totalTokens).toBeGreaterThan(0);
  });
});
