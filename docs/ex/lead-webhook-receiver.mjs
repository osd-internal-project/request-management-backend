// Minimal receiver for request-management webhooks (lead.* events) — Node 18+, no dependencies.
//
//   WEBHOOK_SECRET=whsec_... PORT=8787 node lead-webhook-receiver.mjs
//   node lead-webhook-receiver.mjs --self-test
//
// Answers 2xx fast and does the work afterwards: the sender waits 10 s, then retries.
// Verifies the Standard Webhooks headers (webhook-id / -timestamp / -signature), so the
// `standardwebhooks` library can replace `verify` below. A secret issued before
// 22 Oct 2026 may be base64url — it verifies here, but rotate it before using that library.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

const TOLERANCE_S = 300;

/** `v1,` + base64 HMAC-SHA256 of `id.timestamp.body`, keyed by the bytes after `whsec_`. */
function sign(secret, id, timestamp, rawBody) {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`).digest('base64')}`;
}

/** True when one of the space-separated signatures is ours and the timestamp is fresh. */
export function verify(secret, rawBody, id, timestamp, signatures, nowS = Date.now() / 1000) {
  if (!id || !timestamp || Math.abs(nowS - Number(timestamp)) > TOLERANCE_S) return false;
  const expected = Buffer.from(sign(secret, id, timestamp, rawBody));
  return String(signatures ?? '')
    .split(' ')
    .some((got) => got.length === expected.length && timingSafeEqual(Buffer.from(got), expected));
}

// shortcut: in-memory dedupe forgets on restart; use a table keyed by webhook-id in production
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
      const id = req.headers['webhook-id'];
      const ok = verify(secret, raw, id, req.headers['webhook-timestamp'], req.headers['webhook-signature']);
      if (!ok) return res.writeHead(401).end('bad signature');

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
  // the Standard Webhooks reference vector
  const secret = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
  const id = 'msg_p5jXN8AQM9LWM0D4loKWxJek';
  const body = '{"test": 2432232314}';
  const ts = '1614265330';
  const sig = 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=';
  const now = Number(ts) + 10;
  const cases = [
    ['valid', verify(secret, body, id, ts, sig, now), true],
    ['one of several signatures', verify(secret, body, id, ts, `v1,old ${sig}`, now), true],
    ['tampered body', verify(secret, `${body} `, id, ts, sig, now), false],
    ['other message id', verify(secret, body, 'msg_other', ts, sig, now), false],
    ['wrong secret', verify('whsec_b3RoZXI=', body, id, ts, sig, now), false],
    ['stale timestamp', verify(secret, body, id, ts, sig, Number(ts) + TOLERANCE_S + 1), false],
    ['missing signature', verify(secret, body, id, ts, undefined, now), false],
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
