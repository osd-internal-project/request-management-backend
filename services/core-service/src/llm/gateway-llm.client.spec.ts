import { GatewayLlmClient } from './gateway-llm.client';

describe('CD-275 the gateway client (OpenAI-compatible)', () => {
  const config = {
    get: jest.fn(() => ({
      url: 'https://llm.example/',
      apiKey: 'k',
      timeoutMs: 5000,
    })),
  };
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('posts chat completions with the key and reads text and usage', async () => {
    const fetchMock = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            model: 'gpt-x',
            choices: [{ message: { content: 'สวัสดี' } }],
            usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
          }),
      }),
    );
    global.fetch = fetchMock as never;

    const result = await new GatewayLlmClient(config as never).chat({
      model: 'gpt-x',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(result).toEqual({
      text: 'สวัสดี',
      model: 'gpt-x',
      usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://llm.example/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe(
      'Bearer k',
    );
  });

  it('embeddings come back in input order', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [
              { index: 1, embedding: [0, 1] },
              { index: 0, embedding: [1, 0] },
            ],
            usage: { prompt_tokens: 3, total_tokens: 3 },
          }),
      }),
    ) as never;
    const result = await new GatewayLlmClient(config as never).embed({
      model: 'e',
      input: ['a', 'b'],
    });
    expect(result.vectors).toEqual([
      [1, 0],
      [0, 1],
    ]);
  });

  it('an error status is UPSTREAM_ERROR without echoing the body; missing settings are named', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({ ok: false, status: 503 }),
    ) as never;
    await expect(
      new GatewayLlmClient(config as never).chat({ model: 'm', messages: [] }),
    ).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR',
      message: 'LLM Gateway ตอบ 503',
    });
    expect(GatewayLlmClient.missingSettings({ url: 'x' })).toEqual([
      'LLM_GATEWAY_API_KEY',
    ]);
  });
});
