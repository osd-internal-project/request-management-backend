import { createHmac } from 'node:crypto';
import { ConfigService } from '@nestjs/config';

import { DomainEventsService } from '../events/domain-events.service';
import { sealSecret } from '../pm/config-rules';
import { WebhookDeliveryService } from './webhook-delivery.service';
import { WebhookDeliveryRepository as DeliveryRepository } from './webhook.repository';
import type {
  ClaimedDelivery,
  WebhookDeliveryRepository,
  WebhookSubscriptionRepository,
} from './webhook.repository';

const KEY = 'test-config-key';
const SECRET = 'whsec_test';

function setup(overrides: { active?: boolean; secretEnc?: string } = {}) {
  const subscriptions = {
    listeningTo: jest
      .fn()
      .mockResolvedValue([{ id: 'sub-1' }, { id: 'sub-2' }]),
    findUnique: jest.fn().mockResolvedValue({
      id: 'sub-1',
      url: 'http://hooks.test/in',
      active: overrides.active ?? true,
      secretEnc: overrides.secretEnc ?? sealSecret(SECRET, KEY),
    }),
  };
  const deliveries = {
    createMany: jest.fn().mockResolvedValue({ count: 2 }),
    claimDue: jest.fn(),
    update: jest.fn().mockResolvedValue({}),
  };
  const values: Record<string, unknown> = {
    'webhook.intervalMs': 0,
    'webhook.privateHosts': ['hooks.test'],
    'projectConfig.secret': KEY,
  };
  const config = { get: (key: string) => values[key] } as ConfigService;
  const events = new DomainEventsService();
  const service = new WebhookDeliveryService(
    subscriptions as unknown as WebhookSubscriptionRepository,
    deliveries as unknown as WebhookDeliveryRepository,
    events,
    config,
  );
  service.onModuleInit();
  return { service, subscriptions, deliveries, events };
}

interface UpdateArg {
  data: { status: string; nextAttemptAt: Date } & Record<string, unknown>;
}
interface CreateManyArg {
  data: { subscriptionId: string; payload: { request_id: string } }[];
}

function updateData(deliveries: { update: jest.Mock }) {
  return (deliveries.update.mock.calls[0] as [UpdateArg])[0].data;
}

function claimed(attempts: number): ClaimedDelivery {
  return {
    id: 'del-1',
    subscriptionId: 'sub-1',
    eventName: 'request.approved',
    eventId: 'evt-1',
    payload: { company_id: 'c1', request_id: 'r1' },
    attempts,
    createdAt: new Date('2026-10-20T00:00:00Z'),
  };
}

describe('G-07 webhook delivery', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch');
  });
  afterEach(() => fetchSpy.mockRestore());

  it('queues one row per listening subscription of the event company', async () => {
    const { events, subscriptions, deliveries } = setup();

    await events.emit({
      name: 'request.approved',
      payload: {
        company_id: 'c1',
        request_id: 'r1',
        request_no: 'REQ-1',
        type_code: 'IT01',
        requester_id: 'u1',
      },
    });

    expect(subscriptions.listeningTo).toHaveBeenCalledWith(
      'c1',
      'request.approved',
    );
    const rows = (deliveries.createMany.mock.calls[0] as [CreateManyArg])[0]
      .data;
    expect(rows.map((row) => row.subscriptionId)).toEqual(['sub-1', 'sub-2']);
    expect(rows[0].payload.request_id).toBe('r1');
  });

  it('a failing queue never fails the emitter', async () => {
    const { events, subscriptions } = setup();
    subscriptions.listeningTo.mockRejectedValue(new Error('db down'));

    await expect(
      events.emit({
        name: 'sla.breached',
        payload: {
          company_id: 'c1',
          request_id: 'r1',
          request_no: null,
          due_at: 'x',
        },
      }),
    ).resolves.toBeUndefined();
  });

  it('2xx → sent, with a signature the receiver can verify', async () => {
    const { service, deliveries } = setup();
    deliveries.claimDue.mockResolvedValue([claimed(1)]);
    fetchSpy.mockResolvedValue(new Response(null, { status: 204 }));

    expect(await service.sweep()).toBe(1);

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = init.body as string;
    const headers = init.headers as Record<string, string>;
    expect(url).toBe('http://hooks.test/in');
    expect(init.redirect).toBe('manual');
    expect(headers['X-Webhook-Id']).toBe('evt-1');
    const mac = createHmac('sha256', SECRET)
      .update(`${headers['X-Webhook-Timestamp']}.${body}`)
      .digest('hex');
    expect(headers['X-Webhook-Signature']).toBe(`sha256=${mac}`);
    expect(JSON.parse(body)).toEqual({
      id: 'evt-1',
      event: 'request.approved',
      created_at: '2026-10-20T00:00:00.000Z',
      data: { company_id: 'c1', request_id: 'r1' },
    });
    expect(updateData(deliveries)).toMatchObject({
      status: 'sent',
      lastStatusCode: 204,
    });
  });

  it('500 → back to pending after the first backoff', async () => {
    const { service, deliveries } = setup();
    deliveries.claimDue.mockResolvedValue([claimed(1)]);
    fetchSpy.mockResolvedValue(new Response('', { status: 500 }));
    const before = Date.now();

    await service.sweep();

    const data = updateData(deliveries);
    expect(data).toMatchObject({ status: 'pending', lastStatusCode: 500 });
    expect(data.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(
      before + 60_000,
    );
  });

  it('a network error on the sixth attempt → dead', async () => {
    const { service, deliveries } = setup();
    deliveries.claimDue.mockResolvedValue([claimed(6)]);
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));

    await service.sweep();

    expect(updateData(deliveries)).toMatchObject({
      status: 'dead',
      lastError: 'ECONNREFUSED',
    });
  });

  it('a closed subscription or an unreadable secret → dead without calling out', async () => {
    for (const overrides of [{ active: false }, { secretEnc: 'garbage' }]) {
      const { service, deliveries } = setup(overrides);
      deliveries.claimDue.mockResolvedValue([claimed(1)]);

      await service.sweep();

      expect(updateData(deliveries).status).toBe('dead');
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('G-07 claimDue uses the app clock', () => {
  it('never the DB NOW() — the session runs in Asia/Bangkok and the clocks drift', async () => {
    const queryRaw = jest.fn().mockResolvedValue([]);
    const repo = new DeliveryRepository({
      $queryRaw: queryRaw,
    } as unknown as ConstructorParameters<typeof DeliveryRepository>[0]);
    const now = new Date('2026-10-20T05:00:00.000Z');

    await repo.claimDue(20, 300_000, now);

    const [sql, ...values] = queryRaw.mock.calls[0] as [
      TemplateStringsArray,
      ...unknown[],
    ];
    expect(sql.join('?')).not.toMatch(/NOW\(\)|CURRENT_TIMESTAMP/i);
    expect(values).toEqual([
      '2026-10-20T05:05:00.000Z',
      '2026-10-20T05:00:00.000Z',
      20,
    ]);
  });
});
