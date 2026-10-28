// ตัวรับ webhook ตัวอย่างสำหรับ event lead.* ของ Request Form Service — Node 18+ ไม่มี dependency
//
//   WEBHOOK_SECRET=whsec_... PORT=8787 node lead-webhook-receiver.mjs   # เปิดตัวรับ
//   node lead-webhook-receiver.mjs --self-test                           # ทดสอบการตรวจลายเซ็น ไม่ต้องมีเครือข่าย
//
// ตอบ 2xx ทันทีแล้วค่อยทำงานต่อ เพราะระบบผู้ส่งรอแค่ 10 วินาที ถ้าไม่ได้ 2xx จะส่งซ้ำ
// ตรวจ header ชุด Standard Webhooks (webhook-id / -timestamp / -signature) จึงใช้ library
// `standardwebhooks` แทนฟังก์ชัน `verify` ข้างล่างได้ — secret ที่ออกก่อน 22 ต.ค. 2569 อาจเป็น
// base64url ซึ่งไฟล์นี้ตรวจได้ แต่ต้องขอออก secret ใหม่ก่อนเปลี่ยนไปใช้ library
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

// ปฏิเสธ request ที่ timestamp ห่างจากเวลาปัจจุบันเกิน 5 นาที กันการนำของเก่ามายิงซ้ำ
const TOLERANCE_S = 300;

/** `v1,` + base64 ของ HMAC-SHA256(`id.timestamp.body`) โดย key คือ bytes ของ secret หลัง `whsec_` */
function sign(secret, id, timestamp, rawBody) {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`).digest('base64')}`;
}

/** true เมื่อมีลายเซ็นตัวใดตัวหนึ่ง (คั่นด้วยช่องว่าง) ตรงกับของเรา และ timestamp ยังไม่เก่า */
export function verify(secret, rawBody, id, timestamp, signatures, nowS = Date.now() / 1000) {
  if (!id || !timestamp || Math.abs(nowS - Number(timestamp)) > TOLERANCE_S) return false;
  const expected = Buffer.from(sign(secret, id, timestamp, rawBody));
  return String(signatures ?? '')
    .split(' ')
    .some((got) => got.length === expected.length && timingSafeEqual(Buffer.from(got), expected));
}

// ตัวอย่างนี้จำ id ที่รับแล้วไว้ใน memory ซึ่งหายเมื่อ restart — ของจริงให้เก็บ webhook-id ในตาราง
const seen = new Set();

// body ไม่มี email หรือเบอร์โทร ถ้าต้องการ ให้เรียก GET {BASE}/crm/ai/leads/{lead_id}
// ด้วย key ที่มี integration.crm.lead.contact.read — event อาจมาสลับลำดับ ถ้าต้องการค่าล่าสุดให้ GET เช่นกัน
function handle(event) {
  const d = event.data;
  switch (event.event) {
    case 'lead.created':
      // Lead ใหม่ (หน้าจอ, intake, ฟอร์ม, ads, import) — เช่น สร้างรายการฝั่งคุณผูกกับ lead_id
      console.log(`Lead ใหม่ ${d.lead_id} "${d.name}" ช่องทาง ${d.source_code ?? '-'}`);
      break;
    case 'lead.updated':
      // แก้ข้อมูล — changed_fields มีแค่ชื่อ field ไม่มีค่า ต้อง GET เพื่ออ่านค่าใหม่
      console.log(`แก้ Lead ${d.lead_id}: ${(d.changed_fields ?? []).join(', ')}`);
      break;
    case 'lead.status_changed':
      // เปลี่ยนสถานะ (รวมคัดออก ซึ่งจะมี reason) — ส่งสถานะเดิมซ้ำไม่มี event
      console.log(`Lead ${d.lead_id}: ${d.previous_status} -> ${d.status}${d.reason ? ` (${d.reason})` : ''}`);
      break;
    case 'lead.intake_updated':
      // แก้ intake data (JSON) — changed_fields คือ key ที่ถูกส่งมา
      console.log(`intake ของ Lead ${d.lead_id}: ${(d.changed_fields ?? []).join(', ')}`);
      break;
    case 'lead.converted':
      // แปลงเป็นโอกาสการขาย — มา event เดียว ไม่มี lead.status_changed คู่
      console.log(`Lead ${d.lead_id} -> โอกาสการขาย ${d.opportunity_code}`);
      break;
    case 'webhook.ping':
      // ผู้ดูแลกด "ทดสอบ" — ไม่ใช่ข้อมูลจริง แค่ตอบ 2xx ก็พอ
      console.log(`ping จาก webhook ${d.webhook_id}`);
      break;
    default:
      // event ที่ไม่ได้สมัครหรือเพิ่มมาใหม่ — ตอบ 2xx ไปแล้ว แค่ไม่ทำอะไร
      console.log(`ignored ${event.event}`);
  }
}

function serve(secret, port) {
  createServer((req, res) => {
    if (req.method !== 'POST') return res.writeHead(405).end();
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      // ตรวจลายเซ็นจาก body ดิบ — JSON.parse แล้ว stringify ใหม่ byte จะไม่ตรง
      const raw = Buffer.concat(chunks).toString('utf8');
      const id = req.headers['webhook-id'];
      const ok = verify(secret, raw, id, req.headers['webhook-timestamp'], req.headers['webhook-signature']);
      if (!ok) return res.writeHead(401).end('bad signature');

      res.writeHead(204).end();
      // การส่งซ้ำ (retry) ใช้ id เดิม — รับแล้วก็ข้าม
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
  // ชุดทดสอบอ้างอิงของ Standard Webhooks
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
    console.error('WEBHOOK_SECRET is required (whsec_… ที่ได้จากผู้ดูแล)');
    process.exit(1);
  }
  serve(secret, Number(process.env.PORT ?? 8787));
}
