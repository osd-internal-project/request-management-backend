/**
 * เดินทุก action ของ Lead ในนามผู้ใช้ที่ถือแค่ `sales_lead` แล้วตรวจทั้งทางที่ต้องผ่านและที่ต้องถูกปฏิเสธ
 * docs/lead-only-access.md คือสเปกของสคริปต์นี้ — แก้ที่นั่นก่อน แล้วค่อยแก้ที่นี่
 *
 *   BASE_URL=http://192.168.31.52:3503/api/v1 API_KEY=rfk_… AS=sale.lead@uat.local \
 *   [OTHER_LEAD_ID=<lead ของบริษัทอื่น>] [AGENT_RECORD_IDS=<id>,<id>] yarn uat:lead-only
 *
 * สร้าง Lead และบริษัทเป้าหมายจริงในบริษัทของ key และไม่ลบ (No hard delete) — ชื่อขึ้นต้นด้วย "UAT lead-only".
 * AGENT_RECORD_IDS = งานที่สั่งจากหน้าจอไว้แล้ว (A01/A02 ไม่มี twin บน Open API); สคริปต์ปิดงานให้ด้วย key (A04).
 */
import { randomUUID } from 'node:crypto';

const BASE_URL = (process.env.BASE_URL ?? 'http://localhost:3003/api/v1').replace(/\/$/, '');
const API_KEY = required('API_KEY');
const AS = required('AS');
const OTHER_LEAD_ID = process.env.OTHER_LEAD_ID;
const AGENT_RECORD_IDS = (process.env.AGENT_RECORD_IDS ?? '').split(',').filter(Boolean);
const RUN = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
const NAME = `UAT lead-only ${RUN}`;

type Json = Record<string, unknown>;
interface Reply {
  readonly status: number;
  readonly body: unknown;
}

let pass = 0;
let fail = 0;
let writes = 0;
const failures: string[] = [];

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`ต้องตั้ง ${name}`);
    process.exit(2);
  }
  return value;
}

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value));
const list = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : isObject(value) && Array.isArray(value.data) ? value.data : [];
const field = (value: unknown, key: string): unknown => (isObject(value) ? value[key] : undefined);

async function call(
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
  acting = true,
): Promise<Reply> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${API_KEY}`,
    'Content-Type': 'application/json',
  };
  if (acting) headers['X-Acting-User'] = AS;
  if (method !== 'GET') headers['Idempotency-Key'] = `uat-lead-${RUN}-${(writes += 1)}`;
  try {
    const res = await fetch(`${BASE_URL}/${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const raw = await res.text();
    let parsed: unknown = raw;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      // Not JSON (a proxy error page): keep the text so the failure shows it.
    }
    return { status: res.status, body: parsed };
  } catch (error) {
    return { status: 0, body: error instanceof Error ? error.message : String(error) };
  }
}

function check(label: string, ok: boolean, detail = ''): boolean {
  if (ok) {
    pass += 1;
    console.log(`  [ผ่าน] ${label}`);
  } else {
    fail += 1;
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
    console.log(`  [ตก]  ${label}${detail ? ` — ${detail}` : ''}`);
  }
  return ok;
}

function expect(label: string, reply: Reply, status: number): unknown {
  check(label, reply.status === status, `ได้ ${reply.status} คาด ${status}: ${text(reply.body).slice(0, 300)}`);
  return reply.status === status ? reply.body : undefined;
}

async function leads(): Promise<void> {
  console.log('\nLead');
  const statuses = list(expect('L01 ขั้นของ Lead', await call('GET', 'crm/leads/statuses'), 200));
  const start = statuses.find((s) => field(s, 'isDefault') === true);
  const next = statuses.find((s) => field(s, 'kind') === 'open' && s !== start);

  const lead = expect('L02 สร้าง Lead', await call('POST', 'crm/leads', { name: NAME, contact_name: 'UAT', phone: '0800000000' }), 201);
  const id = field(lead, 'id');
  if (typeof id !== 'string') return void check('L02 ได้ id ของ Lead', false, text(lead));
  check('L02 เริ่มที่ขั้นเริ่มต้น', field(lead, 'status') === field(start, 'code'), `ได้ ${text(field(lead, 'status'))}`);

  const found = list(expect('L03 ค้นรายชื่อ', await call('GET', `crm/leads?search=${encodeURIComponent(NAME)}`), 200));
  check('L03 พบใบที่สร้าง', found.some((row) => field(row, 'id') === id));
  expect('L04 รายละเอียด', await call('GET', `crm/leads/${id}`), 200);
  expect('L05 แก้รายละเอียด', await call('PATCH', `crm/leads/${id}`, { note: 'UAT แก้รายละเอียด' }), 200);
  expect('L06 รับเป็นเจ้าของ', await call('PATCH', `crm/leads/${id}/owner`, {}), 200);
  if (next) expect('L07 เลื่อนขั้น', await call('PATCH', `crm/leads/${id}/status`, { status: field(next, 'code') }), 200);
  else check('L07 มีขั้น open ให้เลื่อน', false, text(statuses));
  expect('L08 intake data', await call('PATCH', `crm/leads/${id}/intake-data`, { data: { uat: RUN } }), 200);

  const activity = expect('L09 บันทึกกิจกรรม', await call('POST', `crm/leads/${id}/activities`, { type: 'call', subject: 'UAT โทรครั้งแรก' }), 201);
  const activityId = field(activity, 'id');
  if (typeof activityId === 'string') {
    expect('L10 ปิดกิจกรรม', await call('PATCH', `crm/leads/${id}/activities/${activityId}`, { completed: true, outcome: 'reached' }), 200);
  } else check('L09 ได้ id ของกิจกรรม', false, text(activity));

  const importId = randomUUID();
  const rows = [{ row_no: 1, name: `${NAME} นำเข้า` }];
  expect('L11 นำเข้า (ตรวจก่อน)', await call('POST', 'crm/leads/import', { mode: 'dry_run', import_id: importId, rows }), 201);
  expect('L12 นำเข้า (จริง)', await call('POST', 'crm/leads/import', { mode: 'commit', import_id: importId, rows }), 201);

  const spare = field(expect('L13 สร้างใบที่จะปิด', await call('POST', 'crm/leads', { name: `${NAME} ปิด` }), 201), 'id');
  if (typeof spare === 'string') {
    expect('L13 ปิดไม่ได้ไปต่อ', await call('POST', `crm/leads/${spare}/disqualify`, { reason: 'UAT ไม่มีงบ' }), 201);
  }

  const converted = expect('L14 แปลงเป็นดีล', await call('POST', `crm/leads/${id}/convert`, { title: `${NAME} ดีล`, amount: 1000 }), 201);
  const after = expect('L14 อ่านหลังแปลง', await call('GET', `crm/leads/${id}`), 200);
  check('L14 สถานะเป็น converted', field(after, 'status') === 'converted', `ได้ ${text(field(after, 'status'))} / ${text(converted).slice(0, 200)}`);

  expect('A03 agent อ่าน Lead (key ไม่มีคน)', await call('GET', `crm/ai/leads/${id}`, undefined, false), 200);
}

async function targetAccounts(): Promise<void> {
  console.log('\nบริษัทเป้าหมาย');
  const account = field(expect('T01 เพิ่ม', await call('POST', 'crm/target-accounts', { name: `${NAME} เป้าหมาย`, priority: 'high' }), 201), 'id');
  const listed = list(expect('T02 รายการ', await call('GET', 'crm/target-accounts'), 200));
  if (typeof account !== 'string') return void check('T01 ได้ id', false);
  check('T02 พบใบที่เพิ่ม', listed.some((row) => field(row, 'id') === account));
  expect('T03 แก้', await call('PATCH', `crm/target-accounts/${account}`, { note: 'UAT' }), 200);
  expect('T04 เริ่มเข้าหา → Lead', await call('POST', `crm/target-accounts/${account}/approach`, { contact_name: 'UAT' }), 201);

  const second = field(expect('T05 เพิ่มใบที่จะเลิก', await call('POST', 'crm/target-accounts', { name: `${NAME} เลิกเล็ง` }), 201), 'id');
  if (typeof second === 'string') {
    expect('T05 เลิกเล็ง', await call('POST', `crm/target-accounts/${second}/drop`, { reason: 'UAT' }), 201);
    expect('T06 เล็งใหม่', await call('POST', `crm/target-accounts/${second}/reopen`), 201);
  }
}

async function refusals(): Promise<void> {
  console.log('\nต้องถูกปฏิเสธ');
  expect('X01 ดีล', await call('GET', 'crm/opportunities'), 403);
  expect('X02 ใบเสนอราคา', await call('GET', 'crm/quotations'), 403);
  expect('X03 ใบสั่งขาย', await call('GET', 'crm/sale-orders'), 403);
  if (OTHER_LEAD_ID) expect('X04 Lead ของบริษัทอื่น', await call('GET', `crm/leads/${OTHER_LEAD_ID}`), 404);
}

async function agent(): Promise<void> {
  if (!AGENT_RECORD_IDS.length) return;
  console.log('\nagent');
  for (const id of AGENT_RECORD_IDS) {
    expect(`A04 ปิดงาน ${id}`, await call('PATCH', `agent-records/${id}`, { status: 'done', result: { uat: RUN } }, false), 200);
  }
}

async function main(): Promise<void> {
  console.log(`UAT lead-only ${RUN} → ${BASE_URL} ในนาม ${AS}`);
  await leads();
  await targetAccounts();
  await refusals();
  await agent();

  console.log(`\nผ่าน ${pass} · ตก ${fail}`);
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exitCode = fail ? 1 : 0;
}

void main();
