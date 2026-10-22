// Minimal receiver for request-management webhooks (lead.* events) — Node 18+, no dependencies.
//
//   WEBHOOK_SECRET=whsec_... PORT=8787 node lead-webhook-receiver.mjs
//   node lead-webhook-receiver.mjs --self-test
//
// Answers 2xx fast and does the work afterwards: the sender waits 10 s, then retries.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

const TOLERANCE_S = 300;

/** True when `signature` is ours for this timestamp and raw body, and the timestamp is fresh. */
export function verify(secret, rawBody, timestamp, signature, nowS = Date.now() / 1000) {
  if (!timestamp || Math.abs(nowS - Number(timestamp)) > TOLERANCE_S) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`;
  const got = String(signature ?? '');
  return got.length === expected.length && timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

// shortcut: in-memory dedupe forgets on restart; use a table keyed by X-Webhook-Id in production
const seen = new Set();

function handle(event) {
  const { lead_id, status } = event.data;
  switch (event.event) {
    case 'lead.created':
    case 'lead.updated':
    case 'lead.status_changed':
    case 'lead.intake_updated':
    case 'lead.converted':
      // email is not in the payload — GET /api/v1/crm/ai/leads/{lead_id} with a contact.read key
      console.log(`${event.event} lead=${lead_id} status=${status}`, event.data);
      break;
    default:
      console.log(`ignored ${event.event}`);
  }
}

function serve(secret, port) {
  createServer((req, res) => {
    if (req.method !== 'POST') return res.writeHead(405).end();
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const ok = verify(secret, raw, req.headers['x-webhook-timestamp'], req.headers['x-webhook-signature']);
      if (!ok) return res.writeHead(401).end('bad signature');

      const id = req.headers['x-webhook-id'];
      res.writeHead(204).end();
      if (seen.has(id)) return;
      seen.add(id);
      try {
        handle(JSON.parse(raw));
      } catch (error) {
        console.error(`event ${id} failed:`, error);
      }
    });
  }).listen(port, () => console.log(`listening on :${port}`));
}

function selfTest() {
  const secret = 'whsec_test';
  const body = JSON.stringify({ id: 'e1', event: 'lead.created', data: { lead_id: 'l1' } });
  const ts = '1761100000';
  const sig = `sha256=${createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`;
  const now = Number(ts) + 10;
  const cases = [
    ['valid', verify(secret, body, ts, sig, now), true],
    ['tampered body', verify(secret, `${body} `, ts, sig, now), false],
    ['wrong secret', verify('whsec_other', body, ts, sig, now), false],
    ['stale timestamp', verify(secret, body, ts, sig, Number(ts) + TOLERANCE_S + 1), false],
    ['missing signature', verify(secret, body, ts, undefined, now), false],
  ];
  let failed = 0;
  for (const [name, got, want] of cases) {
    const pass = got === want;
    if (!pass) failed += 1;
    console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}`);
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv.includes('--self-test')) {
  selfTest();
} else {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) {
    console.error('WEBHOOK_SECRET is required');
    process.exit(1);
  }
  serve(secret, Number(process.env.PORT ?? 8787));
}
