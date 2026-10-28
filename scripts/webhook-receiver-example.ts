/**
 * Example receiver for outbound webhooks (lead.* and the rest) — the code an
 * integrator copies. Self-contained on purpose: only node:http + node:crypto.
 *
 *   WEBHOOK_SECRET=whsec_… yarn webhook:receive          # listen on PORT (4545)
 *   yarn webhook:receive --self-check                    # verify() + the real sender → this receiver
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { strict as assert } from 'node:assert';

const TOLERANCE_SEC = 300;

/** Same formula as the sender: `sha256=` + HMAC-SHA256(secret, `${ts}.${body}`). */
export function verify(
  secret: string,
  timestamp: string,
  signature: string,
  body: string,
  nowSec: number,
): boolean {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > TOLERANCE_SEC) {
    return false;
  }
  const expected = Buffer.from(
    'sha256=' +
      createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex'),
  );
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

type WebhookEnvelope = {
  id: string;
  event: string;
  created_at: string;
  data: Record<string, unknown>;
};

/** The HTTP server, apart from the CLI, so the self-check can drive it. */
export function createReceiver(
  secret: string,
  onEvent: (envelope: WebhookEnvelope) => void,
): Server {
  // shortcut: in-memory dedupe forgets on restart, a real receiver stores seen ids durably
  const seen = new Set<string>();
  return createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('error', () => res.writeHead(400).end());
    req.on('end', () => {
      // verify the raw bytes — re-serialising parsed JSON changes the signature
      const body = Buffer.concat(chunks).toString('utf8');
      const ok = verify(
        secret,
        String(req.headers['x-webhook-timestamp'] ?? ''),
        String(req.headers['x-webhook-signature'] ?? ''),
        body,
        Math.floor(Date.now() / 1000),
      );
      if (!ok) {
        console.warn('rejected: bad signature or stale timestamp');
        res.writeHead(401).end();
        return;
      }
      let envelope: WebhookEnvelope;
      try {
        envelope = JSON.parse(body) as WebhookEnvelope; // signed by the sender, shape per docs/openapi/external-webhook.json
      } catch {
        res.writeHead(400).end();
        return;
      }
      // delivery is at-least-once: a retry carries the same id
      if (seen.has(envelope.id)) {
        res.writeHead(200).end();
        return;
      }
      seen.add(envelope.id);
      onEvent(envelope);
      res.writeHead(200).end();
    });
  });
}

function handle({ event, data }: WebhookEnvelope): void {
  switch (event) {
    case 'lead.created':
      console.log(`new lead ${data.lead_id} "${data.name}" via ${data.source_code ?? '-'}`);
      break;
    case 'lead.status_changed':
      console.log(`lead ${data.lead_id}: ${data.previous_status} -> ${data.status}`);
      break;
    case 'lead.converted':
      console.log(`lead ${data.lead_id} -> opportunity ${data.opportunity_code}`);
      break;
    default:
      console.log(event, JSON.stringify(data));
  }
}

async function selfCheck(): Promise<void> {
  // the sender's own signer, so a drift in either formula fails here
  const { signWebhook } = await import(
    '../services/core-service/src/webhook/webhook-rules'
  );
  const secret = 'whsec_selfcheck';
  const now = 1_800_000_000;
  const ts = String(now);
  const body = '{"id":"evt_1","event":"lead.created","data":{}}';
  const sig = signWebhook(secret, ts, body);

  assert.equal(verify(secret, ts, sig, body, now), true, 'valid signature');
  assert.equal(verify(secret, ts, sig, body + ' ', now), false, 'tampered body');
  assert.equal(
    verify(secret, ts, sig, body, now + TOLERANCE_SEC + 1),
    false,
    'stale timestamp',
  );

  // the real WebhookDeliveryService: body, signature, fetch, address check, result handling
  const delivered = await sendThroughRealSender(secret, secret);
  assert.equal(delivered.received?.event, 'lead.created', 'receiver got the event');
  assert.equal(delivered.received?.data.lead_id, 'L1', 'receiver got the payload');
  assert.equal(delivered.update.status, 'sent', 'sender marked sent');
  assert.equal(delivered.update.lastStatusCode, 200, 'receiver answered 200');

  const refused = await sendThroughRealSender(secret, 'whsec_other');
  assert.equal(refused.received, undefined, 'wrong secret reaches no handler');
  assert.equal(refused.update.status, 'pending', 'sender schedules a retry');
  assert.equal(refused.update.lastStatusCode, 401, 'receiver answered 401');

  console.log('self-check: 5/5 passed');
}

/**
 * One delivery from the real sender to this receiver on 127.0.0.1. Repositories
 * are stubs as in webhook-delivery.spec.ts, so no database is touched.
 */
async function sendThroughRealSender(
  senderSecret: string,
  receiverSecret: string,
): Promise<{
  received: WebhookEnvelope | undefined;
  update: Record<string, unknown>;
}> {
  const { WebhookDeliveryService } = await import(
    '../services/core-service/src/webhook/webhook-delivery.service'
  );
  const { DomainEventsService } = await import(
    '../services/core-service/src/events/domain-events.service'
  );
  const { sealSecret } = await import('../services/core-service/src/pm/config-rules');

  let received: WebhookEnvelope | undefined;
  const server = createReceiver(receiverSecret, (envelope) => {
    received = envelope;
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo; // listen() on a port always yields AddressInfo

  const configKey = 'self-check-config-key';
  const updates: { data: Record<string, unknown> }[] = [];
  const subscriptions = {
    findUnique: async () => ({
      id: 'sub-1',
      url: `http://127.0.0.1:${port}/hooks/ctd`,
      active: true,
      secretEnc: sealSecret(senderSecret, configKey),
    }),
  };
  const deliveries = {
    claimDue: async () => [
      {
        id: 'del-1',
        subscriptionId: 'sub-1',
        eventName: 'lead.created',
        eventId: `evt-${receiverSecret}`,
        payload: { company_id: 'c1', lead_id: 'L1', name: 'บจก. ตัวอย่าง' },
        attempts: 1,
        createdAt: new Date(),
      },
    ],
    update: async (arg: { data: Record<string, unknown> }) => {
      updates.push(arg);
      return {};
    },
  };
  const values: Record<string, unknown> = {
    'webhook.intervalMs': 0,
    // test-only config: lets the sender call this process, nothing else changes
    'webhook.privateHosts': ['127.0.0.1'],
    'projectConfig.secret': configKey,
  };
  type Ctor = ConstructorParameters<typeof WebhookDeliveryService>;
  const sender = new WebhookDeliveryService(
    subscriptions as unknown as Ctor[0], // stub: only the methods deliver() calls
    deliveries as unknown as Ctor[1],
    new DomainEventsService(),
    { get: (key: string) => values[key] } as unknown as Ctor[3],
  );
  try {
    await sender.sweep();
  } finally {
    server.close();
  }
  assert.equal(updates.length, 1, 'exactly one delivery outcome');
  return { received, update: updates[0].data };
}

function main(): void {
  if (process.argv.includes('--self-check')) {
    selfCheck().catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
    return;
  }
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) {
    console.error('WEBHOOK_SECRET is required (the whsec_… shown once on create)');
    process.exit(1);
  }
  const port = Number(process.env.PORT ?? 4545);
  createReceiver(secret, handle).listen(port, () =>
    console.log(`webhook receiver on :${port}`),
  );
}

if (require.main === module) main();
