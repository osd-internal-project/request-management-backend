import { writeFileSync } from 'node:fs';
import type {
  ApprovalEventPayload,
  DomainEventName,
  EsignEventPayload,
  LeadEventPayload,
  RequestEventPayload,
  SlaEventPayload,
  StepEventPayload,
} from '../services/core-service/src/events/event-catalog';
import { WEBHOOK_PING } from '../services/core-service/src/webhook/webhook-rules';

type Schema = Record<string, unknown>;

const str = (description: string): Schema => ({ type: 'string', description });
const nullableStr = (description: string): Schema => ({
  type: ['string', 'null'],
  description,
});

/*
  Keyed by the catalog's own payload types, so a field added to or dropped from
  an event fails `tsc` here instead of leaving the document behind.
*/
const COMPANY = str('บริษัทที่เกิดเหตุการณ์');
const REQUEST: Record<keyof RequestEventPayload, Schema> = {
  company_id: COMPANY,
  request_id: str('อ่านรายละเอียดด้วย GET /api/v1/request/requests/{request_id}'),
  request_no: nullableStr('เลขที่คำขอ'),
  type_code: str('ชนิดคำขอ'),
  requester_id: str('ผู้ขอ'),
  reason_codes: {
    type: 'array',
    items: { type: 'string' },
    description: 'มีเฉพาะ request.returned',
  },
};
const APPROVAL: Record<keyof ApprovalEventPayload, Schema> = {
  company_id: COMPANY,
  case_id: str('เคสอนุมัติ'),
  request_id: nullableStr('คำขอที่เคสนี้ผูกอยู่ (ถ้ามี)'),
  step: { type: 'integer', description: 'ลำดับขั้นอนุมัติ' },
  approver_id: nullableStr('ผู้อนุมัติของขั้นนี้'),
};
const SLA: Record<keyof SlaEventPayload, Schema> = {
  company_id: COMPANY,
  request_id: str('คำขอ'),
  request_no: nullableStr('เลขที่คำขอ'),
  due_at: { type: 'string', format: 'date-time', description: 'กำหนดเสร็จ' },
};
const ESIGN: Record<keyof EsignEventPayload, Schema> = {
  company_id: COMPANY,
  envelope_id: str('ชุดเอกสารลงนาม'),
  source_type: str('โมดูลที่ส่งลงนาม'),
  source_id: str('รายการต้นทาง'),
  ref_type: str('ชนิดอ้างอิง'),
  ref_id: str('id อ้างอิง'),
};
const STEP: Record<keyof StepEventPayload, Schema> = {
  company_id: COMPANY,
  request_id: str('คำขอ'),
  request_no: nullableStr('เลขที่คำขอ'),
  type_code: str('ชนิดคำขอ'),
  step_code: str('ขั้นที่คำขอเพิ่งเข้า'),
  status: str('สถานะของคำขอ'),
};
const LEAD: Record<keyof LeadEventPayload, Schema> = {
  company_id: COMPANY,
  lead_id: str(
    'อ่านรายละเอียด (รวมอีเมล ถ้า key มี integration.crm.lead.contact.read) ด้วย GET /api/v1/crm/ai/leads/{lead_id}',
  ),
  name: str('ชื่อ Lead (บริษัท/ลูกค้าเป้าหมาย)'),
  status: str('รหัสสถานะหลังเหตุการณ์ — lead_statuses.code ของบริษัท'),
  source_code: nullableStr('ช่องทางที่ Lead เข้ามา'),
  previous_status: str('สถานะก่อนเปลี่ยน — lead.status_changed / lead.converted'),
  changed_fields: {
    type: 'array',
    items: { type: 'string' },
    description: 'ชื่อ field หรือ key ที่เปลี่ยน (ไม่มีค่า) — lead.updated / lead.intake_updated',
  },
  opportunity_id: str('โอกาสการขายที่เกิด — lead.converted'),
  opportunity_code: str('เลขที่โอกาสการขาย — lead.converted'),
  reason: str('เหตุผลที่คัดออก — lead.status_changed จากการคัดออก'),
};
const PING = {
  company_id: COMPANY,
  webhook_id: str('webhook ที่ถูกทดสอบ'),
};

const OPTIONAL = new Set([
  'reason_codes',
  'step',
  'approver_id',
  'previous_status',
  'changed_fields',
  'opportunity_id',
  'opportunity_code',
  'reason',
]);

function object(name: string, fields: Record<string, Schema>): Schema {
  return {
    title: name,
    type: 'object',
    required: Object.keys(fields).filter((key) => !OPTIONAL.has(key)),
    properties: fields,
  };
}

const SCHEMAS = {
  RequestEventData: object('RequestEventData', REQUEST),
  ApprovalEventData: object('ApprovalEventData', APPROVAL),
  SlaEventData: object('SlaEventData', SLA),
  EsignEventData: object('EsignEventData', ESIGN),
  StepEventData: object('StepEventData', STEP),
  LeadEventData: object('LeadEventData', LEAD),
  PingEventData: object('PingEventData', PING),
};

/** Exhaustive over the catalog: a new event without an entry fails `tsc`. */
const EVENTS: Record<
  DomainEventName | typeof WEBHOOK_PING,
  [keyof typeof SCHEMAS, string]
> = {
  'request.submitted': ['RequestEventData', 'ส่งคำขอแล้ว'],
  'request.returned': ['RequestEventData', 'คำขอถูกส่งกลับให้แก้'],
  'request.resubmitted': ['RequestEventData', 'ส่งคำขอที่แก้แล้วอีกครั้ง'],
  'request.cancelled': ['RequestEventData', 'ยกเลิกคำขอ'],
  'request.completed': ['RequestEventData', 'ปิดคำขอแล้ว'],
  'request.approved': ['RequestEventData', 'ผลอนุมัติขั้นสุดท้าย — งานเสร็จและผ่าน'],
  'request.pre_approved': ['RequestEventData', 'อนุมัติก่อนเริ่มงาน — ส่งต่อผู้รับงาน'],
  'request.rejected': ['RequestEventData', 'ไม่อนุมัติ (จบ)'],
  'request.step.entered': ['StepEventData', 'คำขอ (flow v2) เข้าขั้นใหม่'],
  'approval.step.pending': ['ApprovalEventData', 'มีงานรออนุมัติ'],
  'approval.completed': ['ApprovalEventData', 'เคสอนุมัติครบทุกขั้น'],
  'approval.rejected': ['ApprovalEventData', 'เคสอนุมัติถูกปฏิเสธ'],
  'approval.voided': ['ApprovalEventData', 'ข้อมูลเปลี่ยนหลังอนุมัติ — ผลอนุมัติเดิมใช้ไม่ได้'],
  'sla.warning': ['SlaEventData', 'ใกล้เกินกำหนด'],
  'sla.breached': ['SlaEventData', 'เกินกำหนดแล้ว'],
  'esign.completed': ['EsignEventData', 'ลงนามครบทุกคน'],
  'lead.created': ['LeadEventData', 'มี Lead ใหม่ (หน้าจอ, intake, ฟอร์มแคมเปญ)'],
  'lead.updated': ['LeadEventData', 'แก้ข้อมูล Lead'],
  'lead.status_changed': ['LeadEventData', 'Lead เปลี่ยนสถานะ (รวมการคัดออก)'],
  'lead.intake_updated': ['LeadEventData', 'แก้ข้อมูล intake (JSON) ของ Lead'],
  'lead.converted': ['LeadEventData', 'Lead ถูกแปลงเป็นโอกาสการขาย'],
  'webhook.ping': ['PingEventData', 'ปุ่ม "ทดสอบ" ในหน้าตั้งค่า webhook'],
};

const HEADERS = [
  ['X-Webhook-Id', 'id ของ event — ส่งซ้ำได้ ใช้ตัดรายการซ้ำ (ค่าเดียวกับ body.id)'],
  ['X-Webhook-Event', 'ชื่อ event'],
  ['X-Webhook-Timestamp', 'วินาที unix ตอนส่ง — ปฏิเสธถ้าห่างจากเวลาปัจจุบันเกิน 5 นาที'],
  [
    'X-Webhook-Signature',
    '`sha256=` + hex(HMAC-SHA256(secret, `{X-Webhook-Timestamp}.{raw body}`))',
  ],
  ['webhook-id', 'Standard Webhooks — ค่าเดียวกับ X-Webhook-Id'],
  ['webhook-timestamp', 'Standard Webhooks — ค่าเดียวกับ X-Webhook-Timestamp'],
  [
    'webhook-signature',
    'Standard Webhooks — `v1,` + base64(HMAC-SHA256(base64-decode(secret หลัง `whsec_`), `{webhook-id}.{webhook-timestamp}.{raw body}`))',
  ],
].map(([name, description]) => ({
  name,
  in: 'header',
  required: true,
  description,
  schema: { type: 'string' },
}));

const DESCRIPTION = `ระบบส่ง \`POST\` ไปยัง URL ที่ผู้ดูแลตั้งไว้ในหน้า **ผู้ดูแล → Webhook** ทุกครั้งที่เกิด event ที่เลือกไว้ของบริษัทนั้น

**payload บาง** — มีแค่ id กับชนิด event ถ้าต้องการรายละเอียด ให้เรียก External API ด้วย API key ตามปกติ สิทธิ์จึงยังตรวจที่ API และข้อมูลส่วนบุคคลไม่ออกไปกับ webhook

**ตรวจลายเซ็นก่อนเชื่อทุกครั้ง** ด้วย \`HMAC-SHA256(secret, timestamp + "." + raw body)\` ให้เทียบกับ \`X-Webhook-Signature\` แบบ constant-time และใช้ body ดิบก่อน parse JSON — หรือตรวจ \`webhook-signature\` ด้วย library \`standardwebhooks\` (secret ที่ออกก่อน 22 ต.ค. 2569 ต้องออกใหม่ก่อน)

**ตอบ 2xx ภายใน 10 วินาที** แล้วค่อยทำงานต่อเบื้องหลัง ถ้าตอบอย่างอื่นหรือหมดเวลา ระบบจะส่งซ้ำหลัง 1 นาที, 5 นาที, 30 นาที, 2 ชั่วโมง และ 6 ชั่วโมง รวม 6 ครั้ง จากนั้นจะเลิกส่ง ระบบไม่ตาม redirect

**ส่งอย่างน้อยหนึ่งครั้ง แบบ best-effort** — event อาจมาซ้ำหรือสลับลำดับ ให้ตัดรายการซ้ำด้วย \`X-Webhook-Id\` ถ้าบริการเคยล่ม ให้ตรวจสอบย้อนหลังด้วย GET ของ API เดิม`;

/**
 * G-07 — `docs/openapi/external-webhook.json`: the calls this system makes to
 * a partner, as OpenAPI 3.1 `webhooks`. Not cut from the Nest document — these
 * are not routes anyone serves here.
 */
export function writeWebhookDocument(version: string): void {
  const webhooks = Object.fromEntries(
    Object.entries(EVENTS).map(([event, [schema, summary]]) => [
      event,
      {
        post: {
          summary,
          operationId: `webhook_${event.replace(/\./g, '_')}`,
          parameters: HEADERS,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['id', 'event', 'created_at', 'data'],
                  properties: {
                    id: { type: 'string', format: 'uuid' },
                    event: { type: 'string', const: event },
                    created_at: { type: 'string', format: 'date-time' },
                    data: { $ref: `#/components/schemas/${schema}` },
                  },
                },
              },
            },
          },
          responses: {
            '2XX': { description: 'รับแล้ว — ไม่ส่งซ้ำ' },
            default: { description: 'อย่างอื่นทั้งหมด — ส่งซ้ำตามรอบ' },
          },
        },
      },
    ]),
  );

  const document = {
    openapi: '3.1.0',
    info: {
      title: 'Request Form — Webhooks (ระบบส่งออก)',
      description: DESCRIPTION,
      version,
    },
    webhooks,
    components: { schemas: SCHEMAS },
  };

  const file = 'docs/openapi/external-webhook.json';
  writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`);
  console.log(`external-webhook: ${Object.keys(webhooks).length} events → ${file}`);
}
