import { sealSecret } from '../pm/config-rules';
import { parseEndpoints, splitVuvagentUrl } from './outbound-connection';
import { OutboundConnectionsAdminService } from './outbound-connections-admin.service';
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
  id: 'conn-1',
  companyId: 'osd',
  integrationId: 'int-1',
  vendor: 'vuvagent',
  baseUrl: 'https://1.1.1.1',
  secretEnc: sealSecret('sk-aily-real', SECRET),
  endpoints: { 'lead.find': { endpointId: 'ep_192af84b', timeoutMinutes: 45 } },
  active: true,
  createdAt: new Date('2026-10-30T03:00:00Z'),
  updatedAt: new Date('2026-10-30T03:00:00Z'),
  ...over,
});

describe('splitVuvagentUrl', () => {
  it('splits the URL copied from the Vuvagent API page', () => {
    expect(
      splitVuvagentUrl(
        ' https://vuvagent.say2us.com/v1/endpoints/ep_192af84bf2f9417cbf9f4097e050d264 ',
      ),
    ).toEqual({
      baseUrl: 'https://vuvagent.say2us.com',
      endpointId: 'ep_192af84bf2f9417cbf9f4097e050d264',
    });
  });

  it('leaves a bare base URL alone, minus the trailing slash', () => {
    expect(splitVuvagentUrl('https://vuvagent.say2us.com/')).toEqual({
      baseUrl: 'https://vuvagent.say2us.com',
      endpointId: null,
    });
  });
});

describe('parseEndpoints', () => {
  it('keeps known actions, defaults a bad timeout, drops the rest', () => {
    expect(
      parseEndpoints({
        'lead.find': { endpointId: 'ep_1', timeoutMinutes: 0 },
        'gone.action': { endpointId: 'ep_2', timeoutMinutes: 10 },
      }),
    ).toEqual({ 'lead.find': { endpointId: 'ep_1', timeoutMinutes: 30 } });
    expect(parseEndpoints({ 'lead.find': { timeoutMinutes: 10 } })).toEqual({});
    expect(parseEndpoints(null)).toEqual({});
  });
});

describe('VuvagentClient', () => {
  const fetchMock = jest.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as never;
  });

  it("calls the action's endpoint with the opened key and the job body", async () => {
    const connections = { findFirst: jest.fn().mockResolvedValue(row()) };
    fetchMock.mockResolvedValue({ ok: true, status: 202 });
    const client = new VuvagentClient(connections as never, config() as never);

    await client.dispatch('osd', 'lead.find', {
      agent_record_id: 'rec-1',
      topic: 'โลจิสติกส์',
    });

    expect(connections.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { companyId: 'osd', vendor: 'vuvagent', active: true },
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

  it('no active connection fails with where to set it, without calling out', async () => {
    const connections = { findFirst: jest.fn().mockResolvedValue(null) };
    const client = new VuvagentClient(connections as never, config() as never);

    await expect(
      client.dispatch('osd', 'lead.find', { agent_record_id: 'rec-1' }),
    ).rejects.toEqual(
      new VuvagentDispatchError(
        null,
        'ยังไม่ได้ตั้งการเชื่อมต่อ vuvagent ที่หน้า Integrations',
      ),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a connection without this action fails, without calling out', async () => {
    const connections = {
      findFirst: jest.fn().mockResolvedValue(row({ endpoints: {} })),
    };
    const client = new VuvagentClient(connections as never, config() as never);

    await expect(
      client.dispatch('osd', 'lead.find', { agent_record_id: 'rec-1' }),
    ).rejects.toEqual(
      new VuvagentDispatchError(
        null,
        'ยังไม่ได้ตั้ง endpoint ของ lead.find ในการเชื่อมต่อที่หน้า Integrations',
      ),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a private address is refused at call time', async () => {
    const connections = {
      findFirst: jest
        .fn()
        .mockResolvedValue(row({ baseUrl: 'https://192.168.1.10' })),
    };
    const client = new VuvagentClient(connections as never, config() as never);

    await expect(
      client.dispatch('osd', 'lead.find', { agent_record_id: 'rec-1' }),
    ).rejects.toBeInstanceOf(VuvagentDispatchError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a refusal carries the status', async () => {
    const connections = { findFirst: jest.fn().mockResolvedValue(row()) };
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('invalid key'),
    });
    const client = new VuvagentClient(connections as never, config() as never);

    await expect(
      client.dispatch('osd', 'lead.find', { agent_record_id: 'rec-1' }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it('test sends connection_test and reads 401 as a wrong key', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401 });
    const client = new VuvagentClient({} as never, config() as never);

    const result = await client.test(row(), 'lead.find');

    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, { body: string }])[1].body,
    ) as unknown;
    expect(body).toEqual({ agent_record_id: null, connection_test: true });
    expect(result).toMatchObject({
      ok: false,
      status: 401,
      problem: 'Vuvagent ไม่รับ key นี้',
    });
  });
});

describe('OutboundConnectionsAdminService', () => {
  function setup() {
    const connections = {
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
    const vuvagent = {
      test: jest
        .fn()
        .mockResolvedValue({ ok: true, status: 202, ms: 12, problem: null }),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new OutboundConnectionsAdminService(
      connections as never,
      integrations as never,
      vuvagent as never,
      audit as never,
      config() as never,
    );
    return { service, connections, integrations, vuvagent, audit };
  }

  const create = {
    integration_id: 'int-1',
    vendor: 'vuvagent',
    base_url: 'https://1.1.1.1',
    api_key: 'sk-aily-real',
    endpoints: [
      { action: 'lead.find', endpoint_id: 'ep_192af84b', timeout_minutes: 45 },
    ],
  };

  it('stores the key sealed and the endpoints keyed by action; never returns or audits the key', async () => {
    const { service, connections, audit } = setup();

    const result = await service.create(create, actor);

    const data = (
      connections.create.mock.calls[0] as [
        { data: { secretEnc: string; endpoints: unknown } },
      ]
    )[0].data;
    expect(data.secretEnc).not.toContain('sk-aily-real');
    expect(data.endpoints).toEqual({
      'lead.find': { endpointId: 'ep_192af84b', timeoutMinutes: 45 },
    });
    expect(JSON.stringify(result)).not.toContain('sk-aily');
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain('sk-aily');
    expect(result).toMatchObject({
      vendor: 'vuvagent',
      base_url: 'https://1.1.1.1',
      endpoints: [
        {
          action: 'lead.find',
          endpoint_id: 'ep_192af84b',
          timeout_minutes: 45,
        },
      ],
    });
  });

  it('one connection per vendor per company', async () => {
    const { service, connections } = setup();
    connections.findFirst.mockResolvedValue({ id: 'conn-0' });

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
    const { service, integrations, connections } = setup();
    integrations.owned.mockRejectedValue(
      Object.assign(new Error('x'), { code: 'NOT_FOUND' }),
    );
    await expect(service.create(create, actor)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(connections.create).not.toHaveBeenCalled();
  });

  it('update without api_key keeps the stored key', async () => {
    const { service, connections } = setup();
    connections.findFirst.mockResolvedValue(row());

    await service.update('conn-1', { active: false }, actor);

    expect(connections.update).toHaveBeenCalledWith({
      where: { id: 'conn-1' },
      data: { active: false },
    });
  });

  it("reveal opens the stored key; another company's row is 404", async () => {
    const { service, connections } = setup();
    connections.findFirst.mockResolvedValueOnce(row());
    await expect(service.revealKey('conn-1', actor)).resolves.toEqual({
      api_key: 'sk-aily-real',
    });

    connections.findFirst.mockResolvedValueOnce(null);
    await expect(service.revealKey('conn-9', actor)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(connections.findFirst).toHaveBeenLastCalledWith({
      where: { id: 'conn-9', companyId: 'osd' },
    });
  });

  it("test runs on the company's own row and is audited without the key", async () => {
    const { service, connections, vuvagent, audit } = setup();
    connections.findFirst.mockResolvedValue(row());

    await expect(service.test('conn-1', 'lead.find', actor)).resolves.toEqual({
      ok: true,
      status: 202,
      ms: 12,
      problem: null,
    });
    expect(vuvagent.test).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'conn-1' }),
      'lead.find',
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'admin.outbound_connection.tested',
      }),
    );
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain('sk-aily');
  });

  it('lists what each action sends, from AGENT_ACTIONS', () => {
    const { service } = setup();
    expect(service.actions()).toEqual([
      {
        action: 'lead.find',
        vendor: 'vuvagent',
        payload_fields: ['agent_record_id', 'topic'],
        default_timeout_minutes: 30,
      },
    ]);
  });
});
