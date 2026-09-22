import { RunNumberClient } from './run-number.client';

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

  const config = { get: jest.fn(() => 'http://run-number/api/v1') };
  const tokens = {
    integrationToken: jest.fn(() => Promise.resolve('service-token')),
  };
  const companies = {
    findUnique: jest.fn(() =>
      Promise.resolve({ code: 'OSD', docPrefix: 'OSD' }),
    ),
  };

  return {
    client: new RunNumberClient(
      config as never,
      tokens as never,
      companies as never,
    ),
    calls,
    tokens,
  };
}

const headersOf = (call: { init: RequestInit }) =>
  call.init.headers as Record<string, string>;

const input = {
  companyId: 'company-osd',
  docType: 'REQUEST' as const,
  scopeKey: 'PS01',
};

describe('ขอเลขรันข้าม service', () => {
  it('ยืนยันตัวด้วย token ของ core เอง ไม่ใช่ของผู้ใช้', async () => {
    const { client, calls, tokens } = harness();

    await client.issue(input);

    expect(tokens.integrationToken).toHaveBeenCalled();
    expect(headersOf(calls[0]).authorization).toBe('Bearer service-token');
  });

  it('ปักบริษัทของเอกสารผ่าน X-Company-Id', async () => {
    const { client, calls } = harness();

    await client.issue(input);

    expect(headersOf(calls[0])['x-company-id']).toBe('company-osd');
  });

  it('ส่ง prefix ของบริษัทที่อ่านเอง ผู้เรียกไม่ต้องรู้', async () => {
    const { client, calls } = harness();

    await client.issue(input);

    expect(JSON.parse(calls[0].init.body as string)).toMatchObject({
      doc_type: 'REQUEST',
      scope_key: 'PS01',
      company_prefix: 'OSD',
      company_code: 'OSD',
    });
  });

  it('ปฏิเสธเมื่อไม่พบบริษัทของเอกสาร', async () => {
    harness();

    const missing = new RunNumberClient(
      { get: jest.fn(() => 'http://run-number/api/v1') } as never,
      { integrationToken: jest.fn(() => Promise.resolve('t')) } as never,
      { findUnique: jest.fn(() => Promise.resolve(null)) } as never,
    );

    await expect(missing.issue(input)).rejects.toMatchObject({
      code: 'NOT_FOUND',
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

    const code = await client.issueUnused(
      { ...input, idempotencyKey: 'run-number:REQUEST:r1:PS01' },
      (candidate) => Promise.resolve(candidate === 'REQ-1'),
    );

    expect(code).toBe('REQ-2');
    expect(calls.map((call) => headersOf(call)['idempotency-key'])).toEqual([
      'run-number:REQUEST:r1:PS01:0',
      'run-number:REQUEST:r1:PS01:1',
    ]);
  });
});
