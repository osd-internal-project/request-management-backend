/**
 * เดินการเบิกครบวงจรผ่าน Open API ในนามคนจริง แล้วตรวจทุกขั้น — ทั้งทางที่ต้องผ่านและเคสที่ต้องถูกปฏิเสธ
 * docs/disbursement.md §9 คือสเปกของสคริปต์นี้ — แก้ที่นั่นก่อน แล้วค่อยแก้ที่นี่
 *
 *   BASE_URL=http://localhost:3003/api/v1 API_KEY=rfk_… \
 *   REQUESTER=<อีเมล> HEAD=<อีเมลหัวหน้าของผู้ขอ> EXEC=<อีเมลคนในหน่วย FAC> ACCOUNTING=<อีเมลบัญชี> \
 *   yarn uat:disbursement
 *   ONLY=FI06 yarn uat:disbursement   # เฉพาะชุดที่ชื่อขึ้นต้นด้วยคำนี้ (คั่นด้วย , ได้)
 *
 * สร้างคำขอจริง 4 ใบ (FI06 ผ่าน · FI06 ไม่อนุมัติ · FI05 ผ่าน · FI05 ส่วนต่าง) และไม่ลบ — ใบ "FI05 ส่วนต่าง" ตั้งใจค้างที่
 * CLEARING ให้ผู้ทดสอบแนบสลิป REFUND_PROOF ที่หน้าเว็บแล้วปิดเอง (external-service แนบไฟล์ไม่ได้)
 */

const BASE_URL = (process.env.BASE_URL ?? 'http://localhost:3003/api/v1').replace(/\/$/, '');
const API_KEY = required('API_KEY');
const PEOPLE = {
  requester: required('REQUESTER'),
  head: required('HEAD'),
  exec: required('EXEC'),
  accounting: required('ACCOUNTING'),
};
const RUN = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
const TODAY = new Date().toISOString().slice(0, 10);

type Json = Record<string, unknown>;
interface Reply {
  readonly status: number;
  readonly body: unknown;
}

let pass = 0;
let fail = 0;
const failures: string[] = [];
const created: string[] = [];

/** A suite stops at the first step its later steps cannot do without. */
class Stop extends Error {}

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

/** `at(body, 'approvalCases.0.steps')` — undefined when any part is missing. */
function at(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, key) => {
    if (Array.isArray(node)) return node[Number(key)];
    return isObject(node) ? node[key] : undefined;
  }, value);
}

const text = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value));
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

async function call(
  as: string,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  key?: string,
): Promise<Reply> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${API_KEY}`,
    'X-Acting-User': as,
    'Content-Type': 'application/json',
  };
  if (method === 'POST') headers['Idempotency-Key'] = `uat-${RUN}-${key ?? path}`;
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

/** Fails the suite when a step it depends on did not answer `status`. */
function must(label: string, reply: Reply, status: number): Json {
  const ok = check(label, reply.status === status, `ได้ ${reply.status} คาด ${status}: ${text(reply.body).slice(0, 300)}`);
  if (!ok || !isObject(reply.body)) throw new Stop(label);
  return reply.body;
}

/** A refusal: status, error code and (when given) the field it names. */
function refused(label: string, reply: Reply, status: number, code: string, field?: string): void {
  const fields = list(at(reply.body, 'details')).map((d) => at(d, 'field'));
  const ok =
    reply.status === status &&
    at(reply.body, 'code') === code &&
    (field === undefined || fields.includes(field));
  check(
    label,
    ok,
    `ได้ ${reply.status} ${text(at(reply.body, 'code'))} ${text(at(reply.body, 'message'))} fields=${text(fields)}; คาด ${status} ${code}${field ? ` ${field}` : ''}`,
  );
}

const amount = (value: unknown): number => Number(value);

// ---------------------------------------------------------------- shared steps

const userIds = new Map<string, string>();

async function userId(email: string): Promise<string> {
  const known = userIds.get(email);
  if (known) return known;
  const q = encodeURIComponent(email.split('@')[0]);
  const reply = await call(PEOPLE.requester, 'GET', `request/users?q=${q}`);
  const match = list(at(reply.body, 'data')).find((u) => at(u, 'email') === email);
  const id = at(match, 'id');
  if (typeof id !== 'string') {
    check(`หา id ของ ${email}`, false, `ได้ ${reply.status}: ${text(reply.body).slice(0, 200)}`);
    throw new Stop(email);
  }
  userIds.set(email, id);
  return id;
}

interface FormInfo {
  readonly required: string[];
  readonly rowRequired: string[];
  readonly rowKeys: string[];
  readonly refRequired: boolean;
  readonly costCenter: string | null;
  readonly receivers: string[];
}

async function readForm(code: string): Promise<FormInfo> {
  const types = await call(PEOPLE.requester, 'GET', `request/request-types?q=${code}`);
  const codes = list(at(types.body, 'data') ?? types.body).map((t) => at(t, 'code'));
  check(`${code} อยู่ในรายการประเภทคำขอ`, codes.includes(code), `ได้ ${text(codes)}`);

  const body = must(`${code} อ่านฟอร์ม`, await call(PEOPLE.requester, 'GET', `request/request-types/${code}/form`), 200);
  const fields = list(body.form_fields);
  const options = (field: unknown) => list(at(field, 'options')).map((o) => at(o, 'value'));
  const header = fields.find((f) => at(f, 'key') === 'cost_center');
  const columns = list(at(fields.find((f) => at(f, 'key') === 'expense_items'), 'columns'));
  const column = columns.find((c) => at(c, 'key') === 'cost_center');
  const first = [...options(header), ...options(column)].find((v): v is string => typeof v === 'string');
  return {
    required: list(at(body, 'form_schema.required')).map(String),
    rowRequired: list(at(body, 'form_schema.properties.expense_items.items.required')).map(String),
    rowKeys: columns.map((c) => String(at(c, 'key'))),
    refRequired: body.ref_required === true,
    costCenter: process.env.COST_CENTER ?? first ?? null,
    receivers: list(body.receiver_candidates).map((r) => String(at(r, 'id'))),
  };
}

/** Builds `form_data` from what the form requires today — never from the seed. */
function formData(code: string, form: FormInfo, lines: readonly number[], extra: Json = {}): Json {
  const plusDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  const known: Json = {
    cost_center: form.costCenter,
    payee: 'UAT ผู้รับเงิน',
    purpose: `UAT ${code} ${RUN}`,
    remark: 'ทดสอบผ่าน Open API (scripts/uat-disbursement.ts)',
    needed_by: plusDays(1),
    clear_by: plusDays(14),
    account: '000-0-00000-0',
    backname: 'UAT Bank',
  };
  const data: Json = { remark: known.remark, ...extra };
  for (const key of form.required) {
    if (key === 'expense_items') continue;
    data[key] = key in known ? known[key] : `UAT ${key}`;
  }
  const has = (key: string) => form.rowKeys.includes(key) || form.rowRequired.includes(key);
  data.expense_items = lines.map((value, index) => ({
    ...(has('receipt_date') ? { receipt_date: TODAY } : {}),
    description: `UAT รายการ ${index + 1}`,
    ...(has('cost_center') && form.costCenter ? { cost_center: form.costCenter } : {}),
    amount: value,
  }));
  return data;
}

interface Ticket {
  readonly no: string;
  readonly code: string;
}

async function create(code: string, form: FormInfo, lines: readonly number[], extra: Json = {}): Promise<Ticket> {
  const accounting = await userId(PEOPLE.accounting);
  check(`${code} บัญชี (${PEOPLE.accounting}) อยู่ใน receiver_candidates`, form.receivers.includes(accounting));
  const body = {
    type_code: code,
    receiver_user_id: accounting,
    ...(form.refRequired ? { ref_type: 'uat', ref_id: `UAT-${RUN}` } : {}),
    form_data: formData(code, form, lines, extra),
  };
  const res = must(`${code} สร้างคำขอ`, await call(PEOPLE.requester, 'POST', 'request/requests', body, `${code}-${lines.join('-')}-create`), 201);
  const no = String(res.requestNo);
  created.push(`${code} ${no}`);
  check(`${no} สถานะ pending_approval`, res.status === 'pending_approval', `ได้ ${text(res.status)}`);
  return { no, code };
}

async function actions(as: string, t: Ticket): Promise<Json> {
  return must(`${t.no} actions ในนาม ${as}`, await call(as, 'GET', `request/requests/${t.no}/actions`), 200);
}

const actionNames = (body: Json) => list(body.actions).map((a) => at(a, 'action'));

/** Approves the current approval step as `as`, after proving `as` is one of its candidates. */
async function approve(as: string, t: Ticket, stepCode: string): Promise<void> {
  const request = must(`${t.no} อ่านคำขอก่อนอนุมัติ ${stepCode}`, await call(as, 'GET', `request/requests/${t.no}`), 200);
  const current = at(request, 'approvalCases.0.currentStep');
  const step = list(at(request, 'approvalCases.0.steps')).find((s) => at(s, 'stepNo') === current);
  const candidates = list(at(step, 'candidateUserIds'));
  const me = await userId(as);
  if (!check(`${t.no} ${as} เป็นผู้อนุมัติขั้น ${stepCode}`, candidates.includes(me), `candidateUserIds = ${text(candidates)}`)) {
    throw new Stop(stepCode);
  }
  must(`${t.no} ${stepCode} approve`, await call(as, 'POST', `request/requests/${t.no}/actions/approve`, { note: `UAT ${stepCode} อนุมัติ` }, `${t.no}-${stepCode}-approve`), 201);
}

async function expectStep(t: Ticket, as: string, status: string, step: string | null): Promise<Json> {
  const body = await actions(as, t);
  check(
    `${t.no} = ${status} ที่ ${step ?? '(จบ)'}`,
    body.status === status && at(body, 'flow_moves.current') === step,
    `ได้ ${text(body.status)} ที่ ${text(at(body, 'flow_moves.current'))}`,
  );
  return body;
}

async function receive(t: Ticket): Promise<Json> {
  const offered = actionNames(await actions(PEOPLE.accounting, t));
  check(`${t.no} บัญชีเห็น receive`, offered.includes('receive'), `ได้ ${text(offered)}`);
  must(`${t.no} receive`, await call(PEOPLE.accounting, 'POST', `request/requests/${t.no}/actions/receive`, {}, `${t.no}-receive`), 201);
  await expectStep(t, PEOPLE.accounting, 'in_progress', 'DISBURSE');
  return must(`${t.no} ใบเบิกเกิดเอง (by-request)`, await call(PEOPLE.accounting, 'GET', `disbursement/disbursements/by-request/${t.no}`), 200);
}

const doc = (docNo: string, action: string) => `disbursement/disbursements/${docNo}/${action}`;

async function verify(docNo: string): Promise<void> {
  const res = must(
    `${docNo} verify`,
    await call(PEOPLE.accounting, 'POST', doc(docNo, 'verify'), {
      checked_cost_center: true,
      checked_documents: true,
      checked_authority: true,
      note: 'UAT ตรวจครบ',
    }, `${docNo}-verify`),
    201,
  );
  check(`${docNo} verify → APPROVED, ticketMove null`, res.status === 'APPROVED' && res.ticketMove === null, `ได้ ${text(res.status)} ${text(res.ticketMove)}`);
}

async function pay(docNo: string, value: number, method: string, key: string): Promise<Json> {
  return must(
    `${docNo} pay ${value} (${method})`,
    await call(PEOPLE.accounting, 'POST', doc(docNo, 'pay'), { amount: value, method, paid_at: TODAY, reference: `UAT-${RUN}` }, `${docNo}-${key}`),
    201,
  );
}

async function finish(t: Ticket, docNo: string, closeBody: Json): Promise<void> {
  const closed = must(`${docNo} close`, await call(PEOPLE.accounting, 'POST', doc(docNo, 'close'), closeBody, `${docNo}-close`), 201);
  check(
    `${docNo} close → CLOSED, ticketMove.moved`,
    closed.status === 'CLOSED' && at(closed, 'ticketMove.moved') === true,
    `ได้ ${text(closed.status)} ${text(closed.ticketMove)}`,
  );
  const done = await expectStep(t, PEOPLE.requester, 'approved', 'DONE');
  const offered = actionNames(done);
  check(
    `${t.no} ผู้ขอที่ DONE: is_last, ถือขั้น, มี advance ไม่มี close`,
    at(done, 'flow_moves.is_last') === true &&
      at(done, 'flow_moves.holder_user_id') === (await userId(PEOPLE.requester)) &&
      offered.includes('advance') &&
      !offered.includes('close'),
    `ได้ ${text(at(done, 'flow_moves'))} actions=${text(offered)}`,
  );
  const end = must(`${t.no} advance END`, await call(PEOPLE.requester, 'POST', `request/requests/${t.no}/actions/advance`, { to_step: 'END' }, `${t.no}-end`), 201);
  check(`${t.no} คำขอ closed`, end.status === 'closed' && Boolean(end.closedAt), `ได้ ${text(end.status)}`);
  const final = must(`${docNo} อ่านใบเบิกสุดท้าย`, await call(PEOPLE.requester, 'GET', `disbursement/disbursements/${docNo}`), 200);
  check(`${docNo} CLOSED, ticket.status closed`, final.status === 'CLOSED' && at(final, 'ticket.status') === 'closed', `ได้ ${text(final.status)} ${text(final.ticket)}`);
}

// ---------------------------------------------------------------- suites

async function pettyMain(): Promise<void> {
  const form = await readForm('FI06');
  check('FI06 ฟอร์มบังคับ payee', form.required.includes('payee'), `required = ${text(form.required)}`);
  check('FI06 แถวบังคับ receipt_date (ใช้เงินไปแล้ว)', form.rowRequired.includes('receipt_date'), `ได้ ${text(form.rowRequired)}`);
  check('FI06 ไม่ต้องอ้างอิงดีล', !form.refRequired);

  const refs = { so_no: `SO-UAT-${RUN}`, so_subject: 'UAT SO', ticket_no: `TKT-UAT-${RUN}`, project_code: 'PRJ-UAT' };
  const t = await create('FI06', form, [350, 500], refs);
  const head = await expectStep(t, PEOPLE.requester, 'pending_approval', 'HEAD');
  check(`${t.no} HEAD ไปต่อที่ RECEIVE (ไม่มี EXEC)`, at(head, 'flow_moves.forward') === 'RECEIVE', `forward = ${text(at(head, 'flow_moves.forward'))}`);
  await approve(PEOPLE.head, t, 'HEAD');
  await expectStep(t, PEOPLE.accounting, 'submitted', 'RECEIVE');

  const d = await receive(t);
  const docNo = String(d.docNo);
  created.push(`  ใบเบิก ${docNo}`);
  check(
    `${docNo} PETTY_CASH · PENDING_VERIFY · legacy false · ยอด 850`,
    d.kind === 'PETTY_CASH' && d.status === 'PENDING_VERIFY' && d.legacy === false && amount(d.requestedAmount) === 850,
    `ได้ ${text(d.kind)} ${text(d.status)} legacy=${text(d.legacy)} ${text(d.requestedAmount)}`,
  );
  check(
    `${docNo} ผู้รับเงินและอ้างอิง SO/Ticket/Project มาจากฟอร์ม`,
    d.payee === 'UAT ผู้รับเงิน' && at(d, 'references.soNo') === refs.so_no && at(d, 'references.ticketNo') === refs.ticket_no && at(d, 'references.projectCode') === refs.project_code,
    `ได้ payee=${text(d.payee)} references=${text(d.references)}`,
  );

  refused(`${docNo} verify ในนามผู้ขอ`, await call(PEOPLE.requester, 'POST', doc(docNo, 'verify'), { checked_cost_center: true, checked_documents: true, checked_authority: true, note: 'x' }, `${docNo}-n-verify`), 403, 'FORBIDDEN');
  refused(`${docNo} pay ก่อน verify`, await call(PEOPLE.accounting, 'POST', doc(docNo, 'pay'), { amount: 850, method: 'cash' }, `${docNo}-n-pay-early`), 409, 'CONFLICT');
  await verify(docNo);
  refused(`${docNo} close ที่ APPROVED`, await call(PEOPLE.accounting, 'POST', doc(docNo, 'close'), {}, `${docNo}-n-close-early`), 409, 'CONFLICT');
  refused(`${docNo} pay เกินยอด`, await call(PEOPLE.accounting, 'POST', doc(docNo, 'pay'), { amount: 900, method: 'cash' }, `${docNo}-n-pay-over`), 400, 'VALIDATION_FAILED', 'amount');

  const half = await pay(docNo, 350, 'cash', 'pay-1');
  check(`${docNo} งวดแรก → PARTIALLY_PAID`, half.status === 'PARTIALLY_PAID', `ได้ ${text(half.status)}`);
  const full = await pay(docNo, 500, 'transfer', 'pay-2');
  const payouts = list(full.movements).filter((m) => at(m, 'type') === 'PAYOUT');
  check(
    `${docNo} ครบยอด → PAID (ไม่ CLOSED), PAYOUT 2 งวดติดลบ`,
    full.status === 'PAID' && payouts.length === 2 && payouts.every((m) => amount(at(m, 'amount')) < 0),
    `ได้ ${text(full.status)} movements=${text(full.movements).slice(0, 200)}`,
  );

  refused(`${docNo} ผู้ขอส่ง clearing บนเงินสดย่อย`, await call(PEOPLE.requester, 'POST', doc(docNo, 'clearing'), { items: [{ description: 'x', amount: 850 }] }, `${docNo}-n-clearing`), 409, 'CONFLICT');
  refused(`${t.no} บัญชี advance ไป DONE ก่อนใบเบิกปิด`, await call(PEOPLE.accounting, 'POST', `request/requests/${t.no}/actions/advance`, { to_step: 'DONE' }, `${t.no}-n-advance`), 409, 'CONFLICT');
  const early = actionNames(await actions(PEOPLE.requester, t));
  check(`${t.no} ผู้ขอที่ DISBURSE มีแค่ cancel, comment`, early.length === 2 && early.includes('cancel') && early.includes('comment'), `ได้ ${text(early)}`);
  refused(`${t.no} ผู้ขอ cancel หลังเงินออก`, await call(PEOPLE.requester, 'POST', `request/requests/${t.no}/actions/cancel`, { reason: 'UAT ต้องถูกกัน' }, `${t.no}-n-cancel`), 409, 'CONFLICT');

  await finish(t, docNo, {});
}

async function pettyRejected(): Promise<void> {
  const form = await readForm('FI06');
  const t = await create('FI06', form, [120]);
  must(`${t.no} HEAD reject`, await call(PEOPLE.head, 'POST', `request/requests/${t.no}/actions/reject`, { note: 'UAT ไม่อนุมัติ' }, `${t.no}-reject`), 201);
  const request = must(`${t.no} อ่านคำขอหลัง reject`, await call(PEOPLE.requester, 'GET', `request/requests/${t.no}`), 200);
  check(`${t.no} คำขอ rejected`, request.status === 'rejected', `ได้ ${text(request.status)}`);
  const d = await call(PEOPLE.accounting, 'GET', `disbursement/disbursements/by-request/${t.no}`);
  check(`${t.no} ไม่มีใบเบิก (404)`, d.status === 404, `ได้ ${d.status}`);
}

/** FI05 up to PAID; returns the ticket and its disbursement. */
async function advancePaid(lines: readonly number[]): Promise<{ t: Ticket; docNo: string; paid: number }> {
  const form = await readForm('FI05');
  const t = await create('FI05', form, lines);
  const head = await expectStep(t, PEOPLE.requester, 'pending_approval', 'HEAD');
  check(`${t.no} HEAD ไปต่อที่ EXEC`, at(head, 'flow_moves.forward') === 'EXEC', `forward = ${text(at(head, 'flow_moves.forward'))}`);
  await approve(PEOPLE.head, t, 'HEAD');
  await expectStep(t, PEOPLE.requester, 'pending_approval', 'EXEC');
  await approve(PEOPLE.exec, t, 'EXEC');
  await expectStep(t, PEOPLE.accounting, 'submitted', 'RECEIVE');
  const d = await receive(t);
  const docNo = String(d.docNo);
  created.push(`  ใบเบิก ${docNo}`);
  const paid = lines.reduce((sum, v) => sum + v, 0);
  check(
    `${docNo} ADVANCE · ADV-… · PENDING_VERIFY · ยอด ${paid} · มี clearBy`,
    d.kind === 'ADVANCE' && docNo.startsWith('ADV') && d.status === 'PENDING_VERIFY' && amount(d.requestedAmount) === paid && Boolean(d.clearBy),
    `ได้ ${text(d.kind)} ${docNo} ${text(d.status)} ${text(d.requestedAmount)} clearBy=${text(d.clearBy)}`,
  );
  refused(`${docNo} clearing ก่อนจ่าย`, await call(PEOPLE.requester, 'POST', doc(docNo, 'clearing'), { items: [{ description: 'x', amount: 1 }] }, `${docNo}-n-clearing-early`), 409, 'CONFLICT');
  await verify(docNo);
  const res = await pay(docNo, paid, 'transfer', 'pay');
  check(`${docNo} จ่ายครบ → PAID`, res.status === 'PAID', `ได้ ${text(res.status)}`);
  return { t, docNo, paid };
}

async function advanceMain(): Promise<void> {
  const form = await readForm('FI05');
  if (form.refRequired) {
    const body = { type_code: 'FI05', receiver_user_id: await userId(PEOPLE.accounting), form_data: formData('FI05', form, [100]) };
    refused('FI05 ไม่ส่ง ref_id', await call(PEOPLE.requester, 'POST', 'request/requests', body, 'FI05-n-no-ref'), 422, 'REQ_FIELD_MISSING', 'ref_id');
  }
  const { t, docNo, paid } = await advancePaid([3200, 1800]);
  refused(`${docNo} close ก่อนเคลียร์`, await call(PEOPLE.accounting, 'POST', doc(docNo, 'close'), {}, `${docNo}-n-close-early`), 409, 'CONFLICT');
  refused(`${docNo} บัญชีส่ง clearing แทนผู้ขอ`, await call(PEOPLE.accounting, 'POST', doc(docNo, 'clearing'), { items: [{ description: 'x', amount: paid }] }, `${docNo}-n-clearing-acc`), 403, 'FORBIDDEN');

  const items = [
    { description: 'UAT ค่าที่พัก', amount: 3000, receipt_date: TODAY },
    { description: 'UAT ค่าเดินทาง', amount: 1500, receipt_date: TODAY },
  ];
  const first = must(`${docNo} clearing (4,500 จาก 5,000)`, await call(PEOPLE.requester, 'POST', doc(docNo, 'clearing'), { items }, `${docNo}-clearing-1`), 201);
  check(`${docNo} → CLEARING, actual 4500, pending.refund 500`, first.status === 'CLEARING' && amount(first.actualAmount) === 4500 && amount(at(first, 'pending.refund')) === 500, `ได้ ${text(first.status)} ${text(first.actualAmount)} ${text(first.pending)}`);
  const back = must(`${docNo} clearing/return`, await call(PEOPLE.accounting, 'POST', doc(docNo, 'clearing/return'), { reason: 'UAT ใบเสร็จไม่ชัด' }, `${docNo}-return`), 201);
  check(`${docNo} ตีกลับ → PAID`, back.status === 'PAID', `ได้ ${text(back.status)}`);

  const exact = [{ description: 'UAT ค่าที่พัก', amount: 3200, receipt_date: TODAY }, { description: 'UAT ค่าเดินทาง', amount: 1800, receipt_date: TODAY }];
  const again = must(`${docNo} clearing ใหม่ (ยอดพอดี)`, await call(PEOPLE.requester, 'POST', doc(docNo, 'clearing'), { items: exact }, `${docNo}-clearing-2`), 201);
  check(
    `${docNo} ACTUAL ถูกแทนทั้งชุด, ไม่มีส่วนต่าง`,
    again.status === 'CLEARING' && amount(again.actualAmount) === paid && list(again.actual).length === 2 && amount(at(again, 'pending.refund')) === 0 && amount(at(again, 'pending.extraPay')) === 0,
    `ได้ ${text(again.actualAmount)} actual=${list(again.actual).length} ${text(again.pending)}`,
  );
  await finish(t, docNo, {});
}

async function advanceDifference(): Promise<void> {
  const { t, docNo } = await advancePaid([2000]);
  const items = [{ description: 'UAT ค่าอุปกรณ์', amount: 1700, receipt_date: TODAY }];
  const res = must(`${docNo} clearing (1,700 จาก 2,000)`, await call(PEOPLE.requester, 'POST', doc(docNo, 'clearing'), { items }, `${docNo}-clearing`), 201);
  check(`${docNo} pending.refund 300`, amount(at(res, 'pending.refund')) === 300, `ได้ ${text(res.pending)}`);
  refused(`${docNo} close มีส่วนต่างไม่ส่ง method`, await call(PEOPLE.accounting, 'POST', doc(docNo, 'close'), {}, `${docNo}-n-no-method`), 400, 'VALIDATION_FAILED', 'method');
  refused(`${docNo} close ยังไม่แนบสลิป`, await call(PEOPLE.accounting, 'POST', doc(docNo, 'close'), { method: 'cash' }, `${docNo}-n-no-slip`), 400, 'VALIDATION_FAILED', 'files');
  created.push(`  ↳ ${t.no} / ${docNo} ค้าง CLEARING: แนบ REFUND_PROOF ที่หน้าเว็บ → close {method: cash} → ผู้ขอ advance END`);
}

async function main(): Promise<void> {
  console.log(`การเบิกผ่าน Open API · ${BASE_URL} · run ${RUN}`);
  const suites: [string, () => Promise<void>][] = [
    ['FI06 เงินสดย่อย — ครบวงจร', pettyMain],
    ['FI06 เงินสดย่อย — หัวหน้าไม่อนุมัติ', pettyRejected],
    ['FI05 เงินทดรอง — ครบวงจร', advanceMain],
    ['FI05 เงินทดรอง — มีส่วนต่าง (ค้างไว้ให้ UI)', advanceDifference],
  ];
  const only = (process.env.ONLY ?? '').split(',').map((w) => w.trim()).filter(Boolean);
  for (const [name, run] of suites.filter(([name]) => !only.length || only.some((w) => name.startsWith(w)))) {
    console.log(`\n${name}`);
    try {
      await run();
    } catch (error) {
      if (!(error instanceof Stop)) throw error;
      console.log(`  (หยุดชุดนี้ที่: ${error.message})`);
    }
  }
  console.log(`\nสรุป: ผ่าน ${pass} · ตก ${fail}`);
  failures.forEach((f) => console.log(`  ตก: ${f}`));
  console.log('\nคำขอที่สร้าง (คงอยู่ใน DB):');
  created.forEach((c) => console.log(`  ${c}`));
  process.exitCode = fail ? 1 : 0;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
