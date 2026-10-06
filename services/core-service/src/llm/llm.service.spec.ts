import { AppError } from '@request-management/share';
import { LlmService } from './llm.service';
import { MockLlmClient } from './mock-llm.client';

function harness(
  options: {
    setting?: Record<string, unknown> | null;
    used?: number;
    price?: Record<string, unknown> | null;
    client?: Record<string, unknown>;
  } = {},
) {
  const settings = {
    findFirst: jest.fn(() => Promise.resolve(options.setting ?? null)),
  };
  const prices = {
    findFirst: jest.fn(() => Promise.resolve(options.price ?? null)),
  };
  const calls = {
    findMany: jest.fn(() =>
      Promise.resolve(options.used ? [{ totalTokens: options.used }] : []),
    ),
    create: jest.fn(() => Promise.resolve({})),
  };
  const config = {
    get: jest.fn((key: string) =>
      key === 'llm.defaultChatModel'
        ? 'chat-default'
        : key === 'llm.defaultEmbedModel'
          ? 'embed-default'
          : undefined,
    ),
  };
  const service = new LlmService(
    (options.client ?? new MockLlmClient()) as never,
    settings as never,
    prices as never,
    calls as never,
    config as never,
  );
  return { service, calls };
}

const caller = { companyId: 'osd', userId: 'u-1', task: 'summary' };

/** The `data` of the log row written by the n-th `create` call. */
const logged = (create: jest.Mock, n = 0) =>
  (create.mock.calls[n] as unknown as [{ data: Record<string, unknown> }])[0]
    .data;

describe('CD-275 LlmService — every model call through one door', () => {
  it('uses the default model, answers, and logs tokens and cost', async () => {
    const { service, calls } = harness({
      price: { inputPer1k: 1, outputPer1k: 2 },
    });

    const reply = await service.chat(caller, [
      { role: 'user', content: 'สรุปให้หน่อย' },
    ]);

    expect(reply.text).toBe('[mock chat-default] สรุปให้หน่อย');
    const data = logged(calls.create);
    expect(data).toMatchObject({
      companyId: 'osd',
      userId: 'u-1',
      task: 'summary',
      kind: 'chat',
      model: 'chat-default',
      status: 'ok',
      totalTokens: reply.usage.totalTokens,
    });
    expect(typeof data.costEstimate).toBe('number');
  });

  it('the company setting picks the model; embeddings come back in order', async () => {
    const { service } = harness({
      setting: { model: 'bge-m3', monthlyTokenQuota: null, enabled: true },
    });
    const result = await service.embed({ ...caller, task: 'kb.embed' }, [
      'a',
      'b',
    ]);
    expect(result.model).toBe('bge-m3');
    expect(result.vectors).toHaveLength(2);
  });

  it('a task outside the catalogue, or of the wrong kind, is refused', async () => {
    const { service } = harness();
    await expect(
      service.chat({ ...caller, task: 'whatever' }, []),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      service.chat({ ...caller, task: 'kb.embed' }, []),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('quota used up → refused before any call, and the refusal is logged', async () => {
    const client = { mode: 'mock', chat: jest.fn(), embed: jest.fn() };
    const { service, calls } = harness({
      setting: { model: null, monthlyTokenQuota: 1000, enabled: true },
      used: 1000,
      client,
    });
    await expect(
      service.chat(caller, [{ role: 'user', content: 'x' }]),
    ).rejects.toMatchObject({ code: 'LLM_QUOTA_EXCEEDED' });
    expect(client.chat).not.toHaveBeenCalled();
    expect(logged(calls.create)).toMatchObject({
      status: 'quota',
      totalTokens: 0,
    });
  });

  it('a switched-off task is refused', async () => {
    const { service } = harness({
      setting: { model: null, monthlyTokenQuota: null, enabled: false },
    });
    await expect(service.chat(caller, [])).rejects.toMatchObject({
      code: 'LLM_TASK_DISABLED',
    });
  });

  it('a gateway failure is logged and passed on; a failing log never hides the answer', async () => {
    const failing = {
      mode: 'gateway',
      chat: jest.fn(() =>
        Promise.reject(new AppError('UPSTREAM_ERROR', 'LLM Gateway ตอบ 502')),
      ),
      embed: jest.fn(),
    };
    const broken = harness({ client: failing });
    await expect(broken.service.chat(caller, [])).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR',
    });
    expect(logged(broken.calls.create)).toMatchObject({
      status: 'error',
      error: 'LLM Gateway ตอบ 502',
    });

    const fine = harness();
    fine.calls.create.mockRejectedValueOnce(new Error('db down'));
    await expect(
      fine.service.chat(caller, [{ role: 'user', content: 'x' }]),
    ).resolves.toMatchObject({ model: 'chat-default' });
  });
});
