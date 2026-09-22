import { requestContextMiddleware } from '@request-management/share';
import { RunNumberClient } from './run-number.client';

function inRequest(authorization: string | undefined, work: () => Promise<void>) {
  return new Promise<void>((resolve, reject) => {
    requestContextMiddleware(
      { headers: authorization ? { authorization } : {} } as never,
      {} as never,
      () => void work().then(resolve, reject),
    );
  });
}

function harness(response: unknown = { number: 'REQ-OSD-PS01-26090001' }) {
  const calls: { url: string; init: RequestInit }[] = [];

  global.fetch = jest.fn((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(response),
    });
  }) as never;

  const companies = {
    findUnique: jest.fn(() =>
      Promise.resolve({ code: 'OSD', docPrefix: 'OSD' }),
    ),
  };
  const config = { get: jest.fn(() => 'http://run-number/api/v1') };

  return {
    client: new RunNumberClient(config as never, companies as never),
    calls,
  };
}

const input = {
  companyId: 'company-osd',
  docType: 'REQUEST' as const,
  scopeKey: 'PS01',
};

describe('ขอเลขรันข้าม service', () => {
  it('ส่งต่อ credential ของคำขอที่กำลังทำงานอยู่', async () => {
    const { client, calls } = harness();

    await inRequest('Bearer user-token', async () => {
      await client.issue(input);
    });

    expect(calls).toHaveLength(1);
    expect(
      (calls[0].init.headers as Record<string, string>).authorization,
    ).toBe('Bearer user-token');
  });

  /** external-service ยิงมาด้วยกุญแจ `rfk_` — ต้องส่งต่อดิบเหมือนกัน. */
  it('ส่งต่อกุญแจ API ดิบ ไม่แปลงเป็นอย่างอื่น', async () => {
    const { client, calls } = harness();

    await inRequest('Bearer rfk_abc123', async () => {
      await client.issue(input);
    });

    expect(
      (calls[0].init.headers as Record<string, string>).authorization,
    ).toBe('Bearer rfk_abc123');
  });

  it('ปักบริษัทของเอกสารผ่าน X-Company-Id', async () => {
    const { client, calls } = harness();

    await inRequest('Bearer user-token', async () => {
      await client.issue(input);
    });

    expect(
      (calls[0].init.headers as Record<string, string>)['x-company-id'],
    ).toBe('company-osd');
  });

  it('ส่ง prefix ของบริษัทที่อ่านเอง ผู้เรียกไม่ต้องรู้', async () => {
    const { client, calls } = harness();

    await inRequest('Bearer user-token', async () => {
      await client.issue(input);
    });

    expect(JSON.parse(calls[0].init.body as string)).toMatchObject({
      doc_type: 'REQUEST',
      scope_key: 'PS01',
      company_prefix: 'OSD',
      company_code: 'OSD',
    });
  });

  it('ปฏิเสธเมื่อไม่ได้อยู่ในคำขอที่มี credential', async () => {
    const { client } = harness();

    await expect(client.issue(input)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  /** เลขที่ชนของบริษัทอื่นต้องถูกข้าม และแต่ละครั้งใช้คีย์ idempotency คนละตัว. */
  it('วนขอเลขใหม่จนได้เลขที่ยังว่าง', async () => {
    let issued = 0;
    const { client, calls } = harness();
    (global.fetch as jest.Mock).mockImplementation(
      (url: string, init: RequestInit) => {
        calls.push({ url, init });
        issued += 1;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ number: `REQ-${issued}` }),
        });
      },
    );

    await inRequest('Bearer user-token', async () => {
      const code = await client.issueUnused(
        { ...input, idempotencyKey: 'run-number:REQUEST:r1:PS01' },
        (candidate) => Promise.resolve(candidate === 'REQ-1'),
      );

      expect(code).toBe('REQ-2');
    });

    const keys = calls.map(
      (call) => (call.init.headers as Record<string, string>)['idempotency-key'],
    );
    expect(keys).toEqual([
      'run-number:REQUEST:r1:PS01:0',
      'run-number:REQUEST:r1:PS01:1',
    ]);
  });
});
