/**
 * CD-54 — the standard wording of every notification, per event, with the
 * `{{name}}` placeholders each one may use. A company may replace the title
 * and body of any of these from the admin screen (`NotificationTemplate`);
 * without a row, this is what is sent.
 *
 * A new event is added here first — `NotificationsService` renders by event
 * type and throws on one this catalog does not declare, so wording can never
 * again live only inside a service method.
 */
export interface TemplateDefinition {
  eventType: string;
  /** What the admin screen calls it. */
  label: string;
  title: string;
  body: string;
  /** Placeholder → what it holds, and a sample for the preview. */
  variables: Record<string, { label: string; sample: string }>;
}

const REQUEST_NO = { label: 'เลขที่คำขอ', sample: 'REQ-OSD-2609-0012' };
const SUBJECT = {
  label: 'เรื่องที่ขออนุมัติ',
  sample: 'REQ-OSD-2609-0012 · ขออนุมัติส่วนลด',
};

export const NOTIFICATION_TEMPLATES: readonly TemplateDefinition[] = [
  {
    eventType: 'approval.awaiting',
    label: 'มีรายการรออนุมัติ (ถึงผู้อนุมัติ)',
    title: 'มีรายการรออนุมัติ',
    body: '{{subject}} รอการอนุมัติจากคุณ',
    variables: { subject: SUBJECT },
  },
  {
    eventType: 'approval.approved',
    label: 'คำขอได้รับอนุมัติ (ถึงผู้ขอหรือทีมที่ทำต่อ)',
    title: 'คำขอของคุณได้รับอนุมัติ',
    body: '{{subject}} — {{status}}',
    variables: {
      subject: SUBJECT,
      status: { label: 'สถานะงานอนุมัติ', sample: 'approved' },
    },
  },
  {
    eventType: 'approval.rejected',
    label: 'คำขอไม่ได้รับอนุมัติ (ถึงผู้ขอและทีม)',
    title: 'คำขอของคุณไม่ได้รับอนุมัติ',
    body: '{{subject}} — {{status}}',
    variables: {
      subject: SUBJECT,
      status: { label: 'สถานะงานอนุมัติ', sample: 'rejected' },
    },
  },
  {
    eventType: 'approval.returned',
    label: 'คำขอถูกส่งกลับให้แก้ไข (ถึงผู้ขอหรือทีม)',
    title: 'คำขอของคุณถูกส่งกลับให้แก้ไข',
    body: '{{subject}} — {{status}}',
    variables: {
      subject: SUBJECT,
      status: { label: 'สถานะงานอนุมัติ', sample: 'returned' },
    },
  },
  {
    eventType: 'approval.step_passed',
    label: 'ผ่านการอนุมัติหนึ่งชั้น (ถึงผู้ขอ)',
    title: 'ผ่านการอนุมัติขั้นหนึ่งแล้ว',
    body: '{{subject}} ผ่านการอนุมัติขั้น {{step}}',
    variables: {
      subject: SUBJECT,
      step: { label: 'ขั้นที่ผ่าน / ทั้งหมด', sample: '1/3' },
    },
  },
  {
    eventType: 'approval.withdrawn',
    label: 'คำขอถูกยกเลิกระหว่างรออนุมัติ (ถึงผู้อนุมัติ)',
    title: 'คำขอถูกยกเลิก ไม่ต้องอนุมัติแล้ว',
    body: '{{subject}}',
    variables: { subject: SUBJECT },
  },
  {
    eventType: 'approval.overdue',
    label: 'รายการรออนุมัติเกินเวลา (ถึงผู้อนุมัติ)',
    title: 'รายการรออนุมัติเกินเวลาที่ตั้งไว้',
    body: '{{subject}} ยังรอการอนุมัติ',
    variables: { subject: SUBJECT },
  },
  {
    eventType: 'approval.escalated',
    label: 'รายการอนุมัติค้างนาน (ถึงหัวหน้าผู้อนุมัติ)',
    title: 'รายการอนุมัติค้างนานเกินกำหนด',
    body: '{{subject}} ยังรอการอนุมัติ',
    variables: { subject: SUBJECT },
  },
  {
    eventType: 'sla.warning',
    label: 'คำขอใกล้ครบกำหนด SLA',
    title: 'คำขอใกล้ครบกำหนด SLA',
    body: 'คำขอ {{request_no}} จะครบกำหนดภายใน 4 ชั่วโมง',
    variables: { request_no: REQUEST_NO },
  },
  {
    eventType: 'sla.breached',
    label: 'คำขอเกินกำหนด SLA',
    title: 'คำขอเกินกำหนด SLA',
    body: 'คำขอ {{request_no}} เกินกำหนดเวลาที่ตั้งไว้แล้ว',
    variables: { request_no: REQUEST_NO },
  },
  {
    eventType: 'sla.response_overdue',
    label: 'เคสเลยเวลาตอบกลับ',
    title: 'เคสยังไม่มีผู้ตอบกลับเกินเวลา',
    body: 'คำขอ {{request_no}}{{severity_note}} เลยเวลาตอบกลับที่กำหนดแล้ว',
    variables: {
      request_no: REQUEST_NO,
      severity_note: {
        label: 'ระดับความรุนแรง (ว่างถ้าไม่ระบุ)',
        sample: ' (ความรุนแรง สูง)',
      },
    },
  },
  {
    eventType: 'crm.opportunity.stale',
    label: 'โอกาสการขายไม่มีความเคลื่อนไหว',
    title: 'โอกาสการขายไม่มีความเคลื่อนไหว',
    body: '{{opportunity_code}} {{opportunity_title}} ไม่มีกิจกรรมมาแล้วเกิน {{days}} วัน',
    variables: {
      opportunity_code: { label: 'รหัสโอกาสการขาย', sample: 'OPP-OSD-0042' },
      opportunity_title: { label: 'ชื่อดีล', sample: 'ระบบกล้อง อาคาร B' },
      days: { label: 'จำนวนวันที่เงียบ', sample: '14' },
    },
  },
  {
    eventType: 'crm.kyc.expiring',
    label: 'KYC ลูกค้าใกล้หมดอายุ (ถึงผู้รับผิดชอบลูกค้า)',
    title: 'KYC ของลูกค้า {{customer_name}} ใกล้หมดอายุ',
    body: '{{customer_code}} {{customer_name}} — KYC ใช้ได้ถึง {{expires_on}} ยื่นคำขอ KYC ใหม่เพื่อทบทวนก่อนหมดอายุ',
    variables: {
      customer_code: { label: 'รหัสลูกค้า', sample: 'CUS-OSD-000042' },
      customer_name: { label: 'ชื่อลูกค้า', sample: 'บริษัท ตัวอย่าง จำกัด' },
      expires_on: { label: 'วันหมดอายุ', sample: '2026-10-29' },
    },
  },
  {
    eventType: 'crm.kyc.expired',
    label: 'KYC ลูกค้าหมดอายุแล้ว (ถึงผู้รับผิดชอบลูกค้า)',
    title: 'KYC ของลูกค้า {{customer_name}} หมดอายุแล้ว',
    body: '{{customer_code}} {{customer_name}} — KYC หมดอายุเมื่อ {{expires_on}} สถานะกลับเป็นยังไม่ยืนยันตัวตน ยื่นคำขอ KYC ใหม่',
    variables: {
      customer_code: { label: 'รหัสลูกค้า', sample: 'CUS-OSD-000042' },
      customer_name: { label: 'ชื่อลูกค้า', sample: 'บริษัท ตัวอย่าง จำกัด' },
      expires_on: { label: 'วันหมดอายุ', sample: '2026-09-29' },
    },
  },
  {
    eventType: 'notification.digest',
    label: 'สรุปการแจ้งเตือนประจำวัน',
    title: 'สรุปการแจ้งเตือนประจำวัน · {{count}} รายการ',
    body: '{{summary}}\n{{items}}',
    variables: {
      count: { label: 'จำนวนรายการ', sample: '3' },
      summary: {
        label: 'จำนวนแยกตามเรื่อง',
        sample: 'รออนุมัติจากคุณ 2 · เตือนงานขาย 1',
      },
      items: {
        label: 'รายการ (บรรทัดละรายการ)',
        sample: '• มีรายการรออนุมัติ — request:DSC รอการอนุมัติจากคุณ',
      },
    },
  },
];

const BY_EVENT = new Map(
  NOTIFICATION_TEMPLATES.map((definition) => [
    definition.eventType,
    definition,
  ]),
);

export function templateOf(eventType: string): TemplateDefinition | undefined {
  return BY_EVENT.get(eventType);
}

const PLACEHOLDER = /\{\{\s*([a-z_]+)\s*\}\}/g;

/** Fills `{{name}}`; a value not supplied renders empty, never as braces. */
export function renderTemplate(
  text: string,
  values: Record<string, string>,
): string {
  return text.replace(PLACEHOLDER, (_, name: string) => values[name] ?? '');
}

export const TITLE_MAX = 200;
export const BODY_MAX = 2000;

/** Why a company's wording cannot be saved, or []. */
export function templateProblems(
  definition: TemplateDefinition,
  title: string,
  body: string,
): string[] {
  const problems: string[] = [];
  if (!title.trim()) problems.push('หัวข้อต้องไม่ว่าง');
  if (!body.trim()) problems.push('ข้อความต้องไม่ว่าง');
  if (title.length > TITLE_MAX)
    problems.push(`หัวข้อยาวได้ไม่เกิน ${TITLE_MAX} ตัวอักษร`);
  if (body.length > BODY_MAX)
    problems.push(`ข้อความยาวได้ไม่เกิน ${BODY_MAX} ตัวอักษร`);
  const unknown = new Set<string>();
  for (const text of [title, body]) {
    for (const match of text.matchAll(PLACEHOLDER)) {
      if (!(match[1] in definition.variables)) unknown.add(match[1]);
    }
  }
  if (unknown.size) {
    problems.push(
      `ไม่รู้จักตัวแปร ${[...unknown].map((name) => `{{${name}}}`).join(', ')} — ใช้ได้เฉพาะ ${Object.keys(
        definition.variables,
      )
        .map((name) => `{{${name}}}`)
        .join(', ')}`,
    );
  }
  return problems;
}

/**
 * The company's letterhead as an email signature (CD-54: "หัวจดหมายของตัวเอง").
 * Only lines that are set; the company name when no letterhead name is.
 */
export function emailSignature(
  companyName: string,
  letterhead: {
    letterheadNameTh?: string | null;
    letterheadAddress?: string | null;
    letterheadPhone?: string | null;
    letterheadEmail?: string | null;
    letterheadWebsite?: string | null;
  } | null,
): string {
  const lines = [
    letterhead?.letterheadNameTh || companyName,
    letterhead?.letterheadAddress,
    [
      letterhead?.letterheadPhone && `โทร ${letterhead.letterheadPhone}`,
      letterhead?.letterheadEmail,
      letterhead?.letterheadWebsite,
    ]
      .filter(Boolean)
      .join(' · '),
  ].filter((line): line is string => Boolean(line));
  return ['—', ...lines].join('\n');
}
