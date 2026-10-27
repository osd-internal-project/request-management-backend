import { sealSecret } from '../pm/config-rules';
import { IntegrationEndpointsAdminService } from './integration-endpoints-admin.service';
import { VuvagentClient, VuvagentDispatchError } from './vuvagent.client';

const SECRET = 'test-config-secret';
const actor = {
  userId: 'admin-1',
  activeCompanyId: 'osd',
  permissions: ['admin.integration.manage'],
} as never;

function config(values: Record<string, unknown> = {}) {
  const all: Record<string, unknown> = {
    'projectConfig.secret': SECRET,
    // a literal public address, so no DNS lookup runs in the test
    'webhook.privateHosts': [],
    ...values,
  };
  return { get: jest.fn((key: string) => all[key]) };
}

const row = (over: Record<string, unknown> = {}) => ({
  id: 'ep-1',
  companyId: 'osd',
  integrationId: 'int-1',
  action: 'lead.find',
  baseUrl: 'https://1.1.1.1',
  endpointId: 'ep_192af84b',
  apiKeyEnc: sealSecret('sk-aily-real', SECRET),
  active: true,
  createdAt: new Date('2026-10-27T03:00:00Z'),
  updatedAt: new Date('2026-10-27T03:00:00Z'),
  ...over,
});

describe('VuvagentClient', () => {
  const fetchMock = jest.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as never;
  });

  it('calls the company endpoint with the opened key and the job body', async () => {
    const endpoints = { findFirst: jest.fn().mockResolvedValue(row()) };
    fetchMock.mockResolvedValue({ ok: true, status: 202 });
    const client = new VuvagentClient(endpoints as never, config() as never);

    await client.dispatch('osd', 'lead.find', {
      agent_record_id: 'rec-1',
      topic: 'โลจิสติกส์',
    });

    expect(endpoints.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { companyId: 'osd', action: 'lead.find', active: true },
      }),
    );
    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    expect(url).toBe('https://1.1.1.1/v1/endpoints/ep_192af84b');
    expect(init.headers['x-api-key']).toBe('sk-aily-real');
    expect(JSON.parse(init.body)).toEqual({
      agent_record_id: 'rec-1',
      topic: 'โลจิสติกส์',
    });
  });

  it('no active endpoint fails with where to set it, without calling out', async () => {
    const endpoints = { findFirst: jest.fn().mockResolvedValue(null) };
    const client = new VuvagentClient(endpoints as never, config() as never);

    await expect(
      client.dispatch('osd', 'lead.find', { agent_record_id: 'rec-1' }),
    ).rejects.toEqual(
      new VuvagentDispatchError(
        null,
        'ยังไม่ได้ตั้ง endpoint ของ lead.find ที่หน้า Integrations',
      ),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a private address is refused at call time', async () => {
    const endpoints = {
      findFirst: jest
        .fn()
        .mockResolvedValue(row({ baseUrl: 'https://192.168.1.10' })),
    };
    const client = new VuvagentClient(endpoints as never, config() as never);

    await expect(
      client.dispatch('osd', 'lead.find', { agent_record_id: 'rec-1' }),
    ).rejects.toBeInstanceOf(VuvagentDispatchError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a refusal carries the status', async () => {
    const endpoints = { findFirst: jest.fn().mockResolvedValue(row()) };
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('invalid key'),
    });
    const client = new VuvagentClient(endpoints as never, config() as never);

    await expect(
      client.dispatch('osd', 'lead.find', { agent_record_id: 'rec-1' }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });
});

describe('IntegrationEndpointsAdminService', () => {
  function setup() {
    const endpoints = {
      findMany: jest.fn().mockResolvedValue([row()]),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn((args: { data: Record<string, unknown> }) =>
        Promise.resolve(row(args.data)),
      ),
      update: jest.fn((args: { data: Record<string, unknown> }) =>
        Promise.resolve(row(args.data)),
      ),
    };
    const integrations = {
      owned: jest.fn().mockResolvedValue({ id: 'int-1' }),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new IntegrationEndpointsAdminService(
      endpoints as never,
      integrations as never,
      audit as never,
      config() as never,
    );
    return { service, endpoints, integrations, audit };
  }

  const create = {
    integration_id: 'int-1',
    action: 'lead.find',
    base_url: 'https://1.1.1.1',
    endpoint_id: 'ep_192af84b',
    api_key: 'sk-aily-real',
  };

  it('stores the key sealed and never returns or audits it', async () => {
    const { service, endpoints, audit } = setup();

    const result = await service.create(create, actor);

    const data = (
      endpoints.create.mock.calls[0] as [{ data: { apiKeyEnc: string } }]
    )[0].data;
    expect(data.apiKeyEnc).not.toContain('sk-aily-real');
    expect(JSON.stringify(result)).not.toContain('sk-aily');
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain('sk-aily');
    expect(result).toMatchObject({
      action: 'lead.find',
      base_url: 'https://1.1.1.1',
      endpoint_id: 'ep_192af84b',
    });
  });

  it('one endpoint per action per company', async () => {
    const { service, endpoints } = setup();
    endpoints.findFirst.mockResolvedValue({ id: 'ep-0' });

    await expect(service.create(create, actor)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('refuses a plain-http or private base URL', async () => {
    const { service } = setup();
    await expect(
      service.create({ ...create, base_url: 'http://1.1.1.1' }, actor),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      service.create({ ...create, base_url: 'https://10.0.0.5' }, actor),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it("another company's integration answers 404 before anything is written", async () => {
    const { service, integrations, endpoints } = setup();
    integrations.owned.mockRejectedValue(
      Object.assign(new Error('x'), { code: 'NOT_FOUND' }),
    );
    await expect(service.create(create, actor)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(endpoints.create).not.toHaveBeenCalled();
  });

  it('update without api_key keeps the stored key', async () => {
    const { service, endpoints } = setup();
    endpoints.findFirst.mockResolvedValue(row());

    await service.update('ep-1', { active: false }, actor);

    expect(endpoints.update).toHaveBeenCalledWith({
      where: { id: 'ep-1' },
      data: { active: false },
    });
  });

  it("reveal opens the stored key; another company's row is 404", async () => {
    const { service, endpoints } = setup();
    endpoints.findFirst.mockResolvedValueOnce(row());
    await expect(service.revealKey('ep-1', actor)).resolves.toEqual({
      api_key: 'sk-aily-real',
    });

    endpoints.findFirst.mockResolvedValueOnce(null);
    await expect(service.revealKey('ep-9', actor)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(endpoints.findFirst).toHaveBeenLastCalledWith({
      where: { id: 'ep-9', companyId: 'osd' },
    });
  });
});
