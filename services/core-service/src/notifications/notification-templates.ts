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

/** CD-84 — what every handover notice may say. */
const HANDOVER_VARIABLES = {
  opportunity_code: { label: 'รหัสโอกาสการขาย', sample: 'OPP-OSD-0042' },
  opportunity_title: {
    label: 'ชื่อโอกาสการขาย',
    sample: 'ระบบกล้อง อาคาร B',
  },
  customer_name: { label: 'ชื่อลูกค้า', sample: 'บริษัท ลูกค้า จำกัด' },
  team_name: { label: 'ทีมที่รับงาน', sample: 'ฝ่ายติดตั้ง' },
  sender_name: { label: 'ผู้ส่งมอบ', sample: 'สมชาย ขายดี' },
  actor_name: { label: 'ผู้รับ/ผู้ตีกลับ', sample: 'สมหญิง ติดตั้งไว' },
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
    eventType: 'legal.contract.expiring',
    label: 'สัญญาใกล้หมดอายุ (ถึงผู้รับผิดชอบสัญญา)',
    title: 'สัญญา {{contract_no}} จะหมดอายุในอีก {{days_left}} วัน',
    body: '{{contract_title}} กับ {{party}} — สิ้นสุด {{end_on}} ตัดสินใจว่าจะต่ออายุหรือปล่อยให้สิ้นสุด',
    variables: {
      contract_no: { label: 'เลขที่สัญญา', sample: 'NDA-2569-001' },
      contract_title: { label: 'ชื่อสัญญา', sample: 'NDA โครงการระบบกล้อง' },
      party: { label: 'คู่สัญญา', sample: 'บริษัท คู่ค้า จำกัด' },
      end_on: { label: 'วันสิ้นสุด', sample: '2026-12-31' },
      days_left: { label: 'เหลือ (วัน)', sample: '30' },
    },
  },
  {
    eventType: 'legal.contract.expired',
    label: 'สัญญาหมดอายุแล้ว (ถึงผู้รับผิดชอบสัญญา)',
    title: 'สัญญา {{contract_no}} หมดอายุแล้ว',
    body: '{{contract_title}} กับ {{party}} สิ้นสุดเมื่อ {{end_on}}',
    variables: {
      contract_no: { label: 'เลขที่สัญญา', sample: 'NDA-2569-001' },
      contract_title: { label: 'ชื่อสัญญา', sample: 'NDA โครงการระบบกล้อง' },
      party: { label: 'คู่สัญญา', sample: 'บริษัท คู่ค้า จำกัด' },
      end_on: { label: 'วันสิ้นสุด', sample: '2026-12-31' },
    },
  },
  {
    eventType: 'legal.obligation.assigned',
    label: 'ได้รับมอบหมายข้อผูกพันตามสัญญา',
    title: 'ข้อผูกพันใหม่: {{title}}',
    body: 'ตามสัญญา {{contract_no}} · กำหนด {{due_on}} — ดูที่ "ข้อผูกพันของฉัน"',
    variables: {
      title: { label: 'ข้อผูกพัน', sample: 'ส่งรายงานผลบริการรายไตรมาส' },
      contract_no: { label: 'เลขที่สัญญา', sample: 'CTR-2569-0042' },
      due_on: { label: 'กำหนด', sample: '2026-10-15' },
    },
  },
  {
    eventType: 'legal.obligation.due',
    label: 'ข้อผูกพันใกล้ถึงกำหนด',
    title: 'ข้อผูกพันถึงกำหนด {{due_on}}: {{title}}',
    body: 'ตามสัญญา {{contract_no}} — ทำแล้วกด "ทำแล้ว" ที่หน้าข้อผูกพันของฉัน',
    variables: {
      title: { label: 'ข้อผูกพัน', sample: 'ส่งรายงานผลบริการรายไตรมาส' },
      contract_no: { label: 'เลขที่สัญญา', sample: 'CTR-2569-0042' },
      due_on: { label: 'กำหนด', sample: '2026-10-15' },
    },
  },
  {
    eventType: 'legal.obligation.overdue',
    label: 'ข้อผูกพันเลยกำหนด',
    title: 'ข้อผูกพันเลยกำหนดแล้ว: {{title}}',
    body: 'ตามสัญญา {{contract_no}} กำหนด {{due_on}} — ยังไม่ได้บันทึกว่าทำแล้ว',
    variables: {
      title: { label: 'ข้อผูกพัน', sample: 'ส่งรายงานผลบริการรายไตรมาส' },
      contract_no: { label: 'เลขที่สัญญา', sample: 'CTR-2569-0042' },
      due_on: { label: 'กำหนด', sample: '2026-10-15' },
    },
  },
  {
    eventType: 'esign.requested',
    label: 'มีเอกสารรอลงนาม (ผู้ลงนามภายใน)',
    title: 'รอลงนาม: {{title}}',
    body: 'คุณลงนามในฐานะ {{role}} · หมดเขต {{expires_on}}',
    variables: {
      title: { label: 'เอกสาร', sample: 'สัญญาบริการ CTR-2569-0042' },
      role: { label: 'ฐานะผู้ลงนาม', sample: 'ผู้รับจ้าง' },
      expires_on: { label: 'หมดเขต', sample: '14 ต.ค. 2569' },
    },
  },
  {
    eventType: 'esign.reminder',
    label: 'เตือนซ้ำ: เอกสารยังรอคุณลงนาม',
    title: 'ยังรอคุณลงนาม: {{title}}',
    body: 'ลงนามในฐานะ {{role}} · หมดเขต {{expires_on}}',
    variables: {
      title: { label: 'เอกสาร', sample: 'สัญญาบริการ CTR-2569-0042' },
      role: { label: 'ฐานะผู้ลงนาม', sample: 'ผู้รับจ้าง' },
      expires_on: { label: 'หมดเขต', sample: '14 ต.ค. 2569' },
    },
  },
  {
    eventType: 'esign.expiring',
    label: 'คำขอลงนามใกล้หมดอายุ (ถึงผู้ส่งลงนาม)',
    title: 'ใกล้หมดอายุ: {{title}}',
    body: 'ยังลงนามไม่ครบ — หมดเขต {{expires_on}} · ขยายเวลาได้ที่หน้าสัญญา',
    variables: {
      title: { label: 'เอกสาร', sample: 'สัญญาบริการ CTR-2569-0042' },
      expires_on: { label: 'หมดเขต', sample: '14 ต.ค. 2569' },
    },
  },
  {
    eventType: 'esign.expired',
    label: 'คำขอลงนามหมดอายุ (ถึงผู้ส่งลงนาม)',
    title: 'หมดอายุแล้ว: {{title}}',
    body: 'ลงนามไม่ครบก่อนหมดเขต — ส่งลงนามใหม่ได้ที่หน้าสัญญา',
    variables: {
      title: { label: 'เอกสาร', sample: 'สัญญาบริการ CTR-2569-0042' },
    },
  },
  {
    eventType: 'esign.completed',
    label: 'ลงนามครบแล้ว (ถึงผู้ส่งลงนาม)',
    title: 'ลงนามครบแล้ว: {{title}}',
    body: 'ผนึกเอกสารแล้ว · รหัสตรวจสอบ {{verify_code}}',
    variables: {
      title: { label: 'เอกสาร', sample: 'สัญญาบริการ CTR-2569-0042' },
      verify_code: { label: 'รหัสตรวจสอบ', sample: 'ABCD-EFGH-JKLM' },
    },
  },
  {
    eventType: 'esign.declined',
    label: 'ผู้ลงนามปฏิเสธ (ถึงผู้ส่งลงนาม)',
    title: 'ปฏิเสธการลงนาม: {{title}}',
    body: '{{name}} ปฏิเสธ — {{reason}}',
    variables: {
      title: { label: 'เอกสาร', sample: 'สัญญาบริการ CTR-2569-0042' },
      name: { label: 'ผู้ลงนาม', sample: 'คุณสมชาย' },
      reason: { label: 'เหตุผล', sample: 'ขอแก้ข้อ 7' },
    },
  },
  {
    eventType: 'pm.change.decided',
    label: 'ผลพิจารณาคำขอเปลี่ยนแปลงโครงการ (ถึงผู้ยื่น)',
    title: 'โครงการ {{project_no}}: {{change_no}} {{result}}',
    body: '{{title}}',
    variables: {
      project_no: { label: 'เลขที่โครงการ', sample: 'PRJ-OSD-000012' },
      change_no: { label: 'เลขที่คำขอเปลี่ยนแปลง', sample: 'CR-2' },
      result: { label: 'ผล', sample: 'อนุมัติแล้ว' },
      title: { label: 'เรื่อง', sample: 'เพิ่มกล้องชั้น 2' },
    },
  },
  {
    eventType: 'pm.design.decided',
    label: 'ผลพิจารณาแบบรายละเอียด (ถึงผู้ส่ง)',
    title: 'โครงการ {{project_no}}: แบบรายละเอียด {{version}} {{result}}',
    body: '{{project_name}}',
    variables: {
      project_no: { label: 'เลขที่โครงการ', sample: 'PRJ-OSD-000012' },
      project_name: { label: 'ชื่อโครงการ', sample: 'ระบบกล้องอาคาร A' },
      version: { label: 'เวอร์ชันแบบ', sample: 'v2' },
      result: { label: 'ผล', sample: 'อนุมัติแล้ว' },
    },
  },
  {
    eventType: 'pm.uat.assigned',
    label: 'ได้รับมอบหมายประเด็นจาก UAT (ถึงผู้รับผิดชอบ)',
    title: 'โครงการ {{project_no}}: {{finding_no}} {{title}}',
    body: '{{project_name}} — แก้แล้วบันทึกวิธีแก้ที่การ์ด UAT ในหน้าโครงการ',
    variables: {
      project_no: { label: 'เลขที่โครงการ', sample: 'PRJ-OSD-000012' },
      project_name: { label: 'ชื่อโครงการ', sample: 'ระบบกล้องอาคาร A' },
      finding_no: { label: 'เลขที่ประเด็น', sample: 'U-3' },
      title: { label: 'ประเด็น', sample: 'พิมพ์รายงานไม่ได้' },
    },
  },
  {
    eventType: 'pm.acceptance.item_assigned',
    label: 'ได้รับมอบหมายรายการค้างจากการตรวจรับ (ถึงผู้รับผิดชอบ)',
    title: 'โครงการ {{project_no}}: รายการค้างจากการตรวจรับ {{round}}',
    body: '{{project_name}} — ดูกำหนดแก้และปิดรายการได้ที่การ์ดตรวจรับในหน้าโครงการ',
    variables: {
      project_no: { label: 'เลขที่โครงการ', sample: 'PRJ-OSD-000012' },
      project_name: { label: 'ชื่อโครงการ', sample: 'ระบบกล้องอาคาร A' },
      round: { label: 'รอบตรวจรับ', sample: 'A-1' },
    },
  },
  {
    eventType: 'pm.readiness.assigned',
    label: 'ได้รับมอบหมายตรวจความพร้อมก่อนส่งมอบ (ถึงผู้ตรวจ)',
    title: 'โครงการ {{project_no}}: ตรวจความพร้อม — {{line}}',
    body: '{{project_name}} — บันทึกผลผ่าน/ไม่ผ่านได้ที่การ์ดตรวจความพร้อมในหน้าโครงการ',
    variables: {
      project_no: { label: 'เลขที่โครงการ', sample: 'PRJ-OSD-000012' },
      project_name: { label: 'ชื่อโครงการ', sample: 'ระบบกล้องอาคาร A' },
      line: { label: 'รายการตรวจ', sample: 'อบรมผู้ใช้งานแล้ว' },
    },
  },
  {
    eventType: 'pm.status_report.due',
    label: 'ร่างรายงานสถานะโครงการประจำสัปดาห์ (ถึงผู้จัดการโครงการ)',
    title: 'โครงการ {{project_no}}: ร่างรายงานสถานะสัปดาห์นี้พร้อมแล้ว',
    body: '{{project_name}} — เติมงานที่ทำได้ งานสัปดาห์ถัดไป แล้วกดส่ง',
    variables: {
      project_no: { label: 'เลขที่โครงการ', sample: 'PRJ-OSD-000012' },
      project_name: { label: 'ชื่อโครงการ', sample: 'ระบบกล้องอาคาร A' },
    },
  },
  {
    eventType: 'pm.project.close_decided',
    label: 'ผลพิจารณาคำขอปิดโครงการ (ถึงผู้ยื่น)',
    title: 'โครงการ {{project_no}}: {{result}}',
    body: '{{project_name}} — ดูรายละเอียดที่การ์ดปิดโครงการ',
    variables: {
      project_no: { label: 'เลขที่โครงการ', sample: 'PRJ-OSD-000012' },
      project_name: { label: 'ชื่อโครงการ', sample: 'ระบบกล้องอาคาร A' },
      result: { label: 'ผล', sample: 'อนุมัติให้ปิดแล้ว' },
    },
  },
  {
    eventType: 'pm.issue.assigned',
    label: 'ได้รับมอบหมายปัญหาในโครงการ (ถึงเจ้าของปัญหา)',
    title: 'โครงการ {{project_no}}: {{issue_no}} {{title}}',
    body: 'คุณเป็นเจ้าของปัญหานี้ — ดูกำหนดแก้ไขที่หน้าโครงการ',
    variables: {
      project_no: { label: 'เลขที่โครงการ', sample: 'PRJ-OSD-000012' },
      issue_no: { label: 'เลขที่ปัญหา', sample: 'I-3' },
      title: { label: 'ปัญหา', sample: 'อุปกรณ์มาไม่ครบ' },
    },
  },
  {
    eventType: 'pm.task.assigned',
    label: 'ได้รับมอบหมายงานในโครงการ (ถึงผู้รับผิดชอบงาน)',
    title: 'งานใหม่: {{task}}',
    body: 'โครงการ {{project_no}} {{project_name}} — ดูและรายงานได้ที่ "งานของฉัน"',
    variables: {
      task: { label: 'งาน', sample: 'ติดตั้งกล้องชั้น 1' },
      project_no: { label: 'เลขที่โครงการ', sample: 'PRJ-OSD-000012' },
      project_name: {
        label: 'ชื่อโครงการ',
        sample: 'ติดตั้งระบบกล้อง อาคาร A',
      },
    },
  },
  {
    eventType: 'pm.task.done',
    label: 'งานในโครงการเสร็จแล้ว (ถึงผู้จัดการโครงการ)',
    title: 'เสร็จแล้ว: {{task}}',
    body: 'โครงการ {{project_no}} — {{by}} รายงานว่าเสร็จ',
    variables: {
      task: { label: 'งาน', sample: 'ติดตั้งกล้องชั้น 1' },
      project_no: { label: 'เลขที่โครงการ', sample: 'PRJ-OSD-000012' },
      by: { label: 'ผู้รายงาน', sample: 'คุณสมชาย' },
    },
  },
  {
    eventType: 'pm.milestone.slipped',
    label: 'หมุดหมายที่ผูกงวดชำระเลื่อน (ถึงเจ้าของสัญญาและฝ่ายกฎหมาย)',
    title: 'โครงการ {{project_no}}: "{{milestone}}" เลื่อนเป็น {{to}}',
    body: 'เดิมคาดว่า {{from}} — กระทบงวดที่ {{installment_seq}} {{installment_label}} (กำหนดชำระ {{pay_due}})',
    variables: {
      project_no: { label: 'เลขที่โครงการ', sample: 'PRJ-OSD-000012' },
      milestone: { label: 'หมุดหมาย', sample: 'ติดตั้งและทดสอบระบบเสร็จ' },
      from: { label: 'วันที่คาดเดิม', sample: '2027-03-01' },
      to: { label: 'วันที่คาดใหม่', sample: '2027-03-12' },
      installment_seq: { label: 'งวดที่', sample: '2' },
      installment_label: { label: 'ชื่องวด', sample: 'งวดตามความคืบหน้า' },
      pay_due: { label: 'กำหนดชำระ', sample: '2027-03-31' },
    },
  },
  {
    eventType: 'pm.resource.conflict',
    label: 'คนในโครงการของคุณถูกจองซ้อนจากอีกโครงการ (ถึงผู้จัดการโครงการ)',
    title: '{{person}} ถูกจองซ้อนโดยโครงการ {{project_no}}',
    body: '{{from}} ถึง {{to}} ชนกับ {{your_project}} — จัดลำดับ: {{priority}} · เหตุผล: {{reason}}',
    variables: {
      project_no: { label: 'โครงการที่จองเพิ่ม', sample: 'PRJ-OSD-000015' },
      your_project: {
        label: 'โครงการของคุณ',
        sample: 'PRJ-OSD-000012 · ติดตั้งกล้อง อาคาร A',
      },
      person: { label: 'ผู้ถูกจอง', sample: 'คุณสมชาย' },
      from: { label: 'ตั้งแต่', sample: '2026-10-12' },
      to: { label: 'ถึง', sample: '2026-10-16' },
      priority: { label: 'การจัดลำดับ', sample: 'PRJ-OSD-000015 มาก่อน' },
      reason: { label: 'เหตุผล', sample: 'ลูกค้าเร่งเปิดระบบ' },
    },
  },
  {
    eventType: 'pm.cost.warn',
    label: 'ต้นทุนโครงการใกล้เกินงบ (ถึงผู้จัดการโครงการและทีมราคา)',
    title: 'โครงการ {{project_no}}: ต้นทุน{{category}}ใกล้เกินงบ ({{pct}})',
    body: '{{project}} — ต้นทุนจริง {{actual}} บาท จากงบ {{budget}} บาท',
    variables: {
      project_no: { label: 'เลขที่โครงการ', sample: 'PRJ-OSD-000012' },
      project: { label: 'ชื่อโครงการ', sample: 'ติดตั้งกล้องวงจรปิด อาคาร A' },
      category: { label: 'หมวด', sample: 'วัสดุ/อุปกรณ์' },
      budget: { label: 'งบ (บาท)', sample: '1,200,000' },
      actual: { label: 'ต้นทุนจริง (บาท)', sample: '1,130,000' },
      pct: { label: 'ร้อยละของงบ', sample: '94.2%' },
    },
  },
  {
    eventType: 'pm.cost.over',
    label: 'ต้นทุนโครงการเกินงบ (ถึงผู้จัดการโครงการและทีมราคา)',
    title: 'โครงการ {{project_no}}: ต้นทุน{{category}}เกินงบ ({{pct}})',
    body: '{{project}} — ต้นทุนจริง {{actual}} บาท เกินงบ {{budget}} บาท',
    variables: {
      project_no: { label: 'เลขที่โครงการ', sample: 'PRJ-OSD-000012' },
      project: { label: 'ชื่อโครงการ', sample: 'ติดตั้งกล้องวงจรปิด อาคาร A' },
      category: { label: 'หมวด', sample: 'วัสดุ/อุปกรณ์' },
      budget: { label: 'งบ (บาท)', sample: '1,200,000' },
      actual: { label: 'ต้นทุนจริง (บาท)', sample: '1,130,000' },
      pct: { label: 'ร้อยละของงบ', sample: '94.2%' },
    },
  },
  {
    eventType: 'pm.milestone.achieved',
    label: 'หมุดหมายโครงการบรรลุ — งวดชำระวางบิลได้ (ถึงเจ้าของสัญญา)',
    title: 'โครงการ {{project_no}}: บรรลุ "{{milestone}}"',
    body: 'งวดที่ {{installment_seq}} {{installment_label}} ({{amount}} บาท) วางบิลได้แล้ว',
    variables: {
      project_no: { label: 'เลขที่โครงการ', sample: 'PRJ-OSD-000012' },
      milestone: { label: 'หมุดหมาย', sample: 'ติดตั้งและทดสอบระบบเสร็จ' },
      installment_seq: { label: 'งวดที่', sample: '2' },
      installment_label: { label: 'ชื่องวด', sample: 'งวดตามความคืบหน้า' },
      amount: { label: 'จำนวนเงิน', sample: '105,000' },
    },
  },
  {
    eventType: 'hr.timesheet.submitted',
    label: 'Timesheet รออนุมัติ (ถึงหัวหน้า)',
    title: 'Timesheet ของ {{name}} สัปดาห์ {{week}} รออนุมัติ',
    body: 'รวม {{hours}} ชั่วโมง — เปิดหน้า Timesheet เพื่ออนุมัติหรือตีกลับ',
    variables: {
      name: { label: 'ชื่อพนักงาน', sample: 'สมชาย ใจดี' },
      week: { label: 'สัปดาห์ (วันจันทร์)', sample: '05/10/2569' },
      hours: { label: 'ชั่วโมงรวม', sample: '40' },
    },
  },
  {
    eventType: 'hr.timesheet.returned',
    label: 'Timesheet ถูกตีกลับ (ถึงเจ้าของ)',
    title: 'Timesheet สัปดาห์ {{week}} ถูกตีกลับ',
    body: 'เหตุผล: {{reason}} — แก้แล้วส่งใหม่ได้',
    variables: {
      week: { label: 'สัปดาห์ (วันจันทร์)', sample: '05/10/2569' },
      reason: { label: 'เหตุผล', sample: 'ลงเวลาโครงการผิดงานย่อย' },
    },
  },
  {
    eventType: 'hr.leave.requested',
    label: 'คำขอลารออนุมัติ (ถึงหัวหน้า)',
    title: '{{name}} ขอ{{type}} {{period}}',
    body: '{{days}} วันทำการ — เปิดหน้าอนุมัติการลาเพื่ออนุมัติหรือปฏิเสธ',
    variables: {
      name: { label: 'ชื่อพนักงาน', sample: 'สมชาย ใจดี' },
      type: { label: 'ประเภทการลา', sample: 'ลาพักร้อน' },
      period: { label: 'ช่วงวันที่', sample: '12/10/2569 – 14/10/2569' },
      days: { label: 'จำนวนวัน', sample: '3' },
    },
  },
  {
    eventType: 'hr.leave.decided',
    label: 'ผลการขอลา (ถึงเจ้าของ)',
    title: '{{type}} {{period}} — {{outcome}}',
    body: '{{note}}',
    variables: {
      type: { label: 'ประเภทการลา', sample: 'ลาพักร้อน' },
      period: { label: 'ช่วงวันที่', sample: '12/10/2569 – 14/10/2569' },
      outcome: { label: 'ผล', sample: 'อนุมัติแล้ว' },
      note: { label: 'หมายเหตุจากผู้อนุมัติ', sample: 'ช่วงนั้นมีส่งมอบงาน' },
    },
  },
  {
    eventType: 'hr.booking.created',
    label: 'ถูกจองตัวเข้าโครงการ (ถึงตัวคน)',
    title: 'คุณถูกจองเข้าโครงการ {{project}}',
    body: '{{period}} วันละ {{hours}} ชม. — โดย {{by}}',
    variables: {
      project: { label: 'โครงการ', sample: 'PRJ-2026-0001 · ระบบเครือข่าย' },
      period: { label: 'ช่วงวันที่', sample: '12/10/2569 – 30/10/2569' },
      hours: { label: 'ชั่วโมงต่อวัน', sample: '4' },
      by: { label: 'ผู้จอง', sample: 'วิชัย ส.' },
    },
  },
  {
    eventType: 'hr.manday.threshold',
    label: 'Manday ใช้จริงถึงขั้นที่กำหนด (ถึง PM และทีมราคา)',
    title: 'โครงการ {{project}} ใช้ manday ไป {{percent}}% ของแผน',
    body: 'ใช้จริง {{actual}} จากแผน {{planned}} manday (Timesheet ที่อนุมัติแล้ว) — ดูรายละเอียดที่หน้า Manday แผนเทียบจริง',
    variables: {
      project: { label: 'โครงการ', sample: 'PRJ-2026-0001 · ระบบเครือข่าย' },
      percent: { label: 'ร้อยละที่ใช้ไป', sample: '104' },
      actual: { label: 'manday ใช้จริง', sample: '52' },
      planned: { label: 'manday ตามแผน', sample: '50' },
    },
  },
  {
    eventType: 'hr.manday.closed',
    label: 'สรุป manday เมื่อปิดโครงการ (ถึง PM และทีมราคา)',
    title:
      'ปิดโครงการ {{project}}: manday จริง {{actual}} / แผน {{planned}} ({{variance}})',
    body: 'ใช้ปรับการประเมิน manday ของงานถัดไป — ดูแยกตามระดับ × ประเภทงานที่หน้า Manday แผนเทียบจริง',
    variables: {
      project: { label: 'โครงการ', sample: 'PRJ-2026-0001 · ระบบเครือข่าย' },
      actual: { label: 'manday ใช้จริง', sample: '58' },
      planned: { label: 'manday ตามแผน', sample: '50' },
      variance: { label: 'ส่วนต่าง', sample: '+16%' },
    },
  },
  {
    eventType: 'delivery.not_ready',
    label: 'ของยังไม่พร้อมก่อนวันส่งมอบ (ถึง PM และทีม Delivery)',
    title:
      'โครงการ {{project}}: รอบส่งที่ {{seq}} วันที่ {{date}} ของยังไม่พร้อม {{lines}} บรรทัด',
    body: 'ตรวจแผนสำรองหรือเลื่อนวันส่งที่แท็บส่งมอบของโครงการ',
    variables: {
      project: { label: 'โครงการ', sample: 'PRJ-2026-0001 · ระบบเครือข่าย' },
      seq: { label: 'รอบส่ง', sample: '2' },
      date: { label: 'วันที่ส่งตามแผน', sample: '12/10/2569' },
      lines: { label: 'จำนวนบรรทัดที่ไม่พร้อม', sample: '3' },
    },
  },
  {
    eventType: 'pm.project.assigned',
    label: 'ได้รับมอบหมายในโครงการ (ถึงผู้จัดการและทีมโครงการ)',
    title: 'โครงการ {{project_no}}: คุณเป็น{{role}}',
    body: '{{project_name}} — เปิดจากสัญญา {{contract_no}}',
    variables: {
      project_no: { label: 'เลขที่โครงการ', sample: 'PRJ-OSD-000012' },
      project_name: {
        label: 'ชื่อโครงการ',
        sample: 'ติดตั้งระบบกล้อง อาคาร A',
      },
      contract_no: { label: 'เลขที่สัญญา', sample: 'CTR-2569-0042' },
      role: { label: 'บทบาท', sample: 'ผู้จัดการโครงการ' },
    },
  },
  {
    eventType: 'legal.msa.changed',
    label: 'ข้อตกลงหลัก (MSA) ถูกแก้ไข (ถึงผู้รับผิดชอบสัญญาย่อย)',
    title: 'ข้อตกลงหลัก {{master_no}} ถูกแก้ไข',
    body: '{{change}} — สัญญา {{contract_no}} อ้างอิงข้อตกลงนี้ ตรวจว่ากระทบสัญญาของคุณหรือไม่',
    variables: {
      master_no: { label: 'เลขที่ข้อตกลงหลัก', sample: 'MSA-2569-001' },
      master_title: {
        label: 'ชื่อข้อตกลงหลัก',
        sample: 'ข้อตกลงหลักบริการระบบ',
      },
      contract_no: { label: 'เลขที่สัญญาย่อย', sample: 'CTR-2569-0042' },
      change: { label: 'สิ่งที่แก้', sample: 'แก้ไขวันสิ้นสุด' },
    },
  },
  {
    eventType: 'crm.phone_reservation.expiring',
    label: 'เบอร์ที่จองใกล้หมดอายุ (ถึงเจ้าของดีล)',
    title: 'เบอร์ {{number}} ที่จองไว้จะหมดอายุ {{expires_on}}',
    body: '{{opportunity_code}} {{opportunity_title}} — ต่ออายุการจองที่หน้าโอกาสการขาย ถ้ายังต้องการเบอร์นี้',
    variables: {
      number: { label: 'เลขหมาย', sample: '02-100-8888' },
      expires_on: { label: 'วันหมดอายุการจอง', sample: '2026-10-13' },
      opportunity_code: { label: 'รหัสโอกาสการขาย', sample: 'OPP-OSD-0042' },
      opportunity_title: { label: 'ชื่อดีล', sample: 'ระบบโทรศัพท์ สาขา 3' },
    },
  },
  {
    eventType: 'crm.phone_reservation.expired',
    label: 'การจองเบอร์หมดอายุแล้ว (ถึงเจ้าของดีล)',
    title: 'การจองเบอร์ {{number}} หมดอายุแล้ว',
    body: '{{opportunity_code}} {{opportunity_title}} — เบอร์นี้กลับไปเป็นเบอร์ว่าง ถ้ายังต้องการให้จองใหม่',
    variables: {
      number: { label: 'เลขหมาย', sample: '02-100-8888' },
      opportunity_code: { label: 'รหัสโอกาสการขาย', sample: 'OPP-OSD-0042' },
      opportunity_title: { label: 'ชื่อดีล', sample: 'ระบบโทรศัพท์ สาขา 3' },
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
    eventType: 'crm.contract.renewal_opened',
    label: 'เปิดโอกาสต่ออายุสัญญาอัตโนมัติ (ถึงเจ้าของสัญญา)',
    title: 'สัญญา {{contract_no}} ใกล้หมดอายุ — เปิดโอกาสต่ออายุให้แล้ว',
    body: '{{contract_title}} สิ้นสุดในอีก {{days_left}} วัน — ระบบเปิดโอกาสการขาย {{opportunity_code}} สำหรับการต่ออายุให้แล้ว',
    variables: {
      contract_no: { label: 'เลขที่สัญญา', sample: 'CTR-OSD-2609-0003' },
      contract_title: {
        label: 'ชื่อสัญญา',
        sample: 'บริการดูแลระบบกล้อง อาคาร B',
      },
      days_left: { label: 'จำนวนวันก่อนสิ้นสุด', sample: '90' },
      opportunity_code: { label: 'รหัสโอกาสการขาย', sample: 'OPP-OSD-0099' },
    },
  },
  {
    eventType: 'crm.contract.renewal_due',
    label: 'เตือนต่ออายุสัญญาซ้ำ (ถึงเจ้าของสัญญา)',
    title: 'อีก {{days_left}} วัน สัญญา {{contract_no}} จะสิ้นสุด',
    body: '{{contract_title}} — โอกาสต่ออายุ {{opportunity_code}} ยังไม่ปิด',
    variables: {
      contract_no: { label: 'เลขที่สัญญา', sample: 'CTR-OSD-2609-0003' },
      contract_title: {
        label: 'ชื่อสัญญา',
        sample: 'บริการดูแลระบบกล้อง อาคาร B',
      },
      days_left: { label: 'จำนวนวันก่อนสิ้นสุด', sample: '30' },
      opportunity_code: { label: 'รหัสโอกาสการขาย', sample: 'OPP-OSD-0099' },
    },
  },
  {
    eventType: 'crm.invoice.overdue',
    label: 'ใบแจ้งหนี้เลยกำหนดชำระ (ถึงผู้ดูแลลูกค้า)',
    title: 'ใบแจ้งหนี้ {{doc_no}} เลยกำหนดชำระ {{days_overdue}} วัน',
    body: '{{customer_name}} ({{customer_code}}) — ครบกำหนด {{due_on}} ยอดค้าง {{outstanding}} {{currency}}',
    variables: {
      doc_no: { label: 'เลขที่ใบแจ้งหนี้ (SAP)', sample: '10234' },
      customer_code: { label: 'รหัสลูกค้า', sample: 'CUS-OSD-000042' },
      customer_name: { label: 'ชื่อลูกค้า', sample: 'บริษัท ตัวอย่าง จำกัด' },
      due_on: { label: 'วันครบกำหนด', sample: '2026-09-01' },
      days_overdue: { label: 'จำนวนวันที่เลยกำหนด', sample: '30' },
      outstanding: { label: 'ยอดค้าง', sample: '12,500.00' },
      currency: { label: 'สกุลเงิน', sample: 'THB' },
    },
  },
  {
    eventType: 'crm.account.review_due',
    label: 'ถึงรอบทบทวนลูกค้าเดิม (ถึงผู้ดูแลลูกค้า)',
    title: 'ถึงรอบทบทวน {{customer_name}} วันที่ {{review_on}}',
    body: '{{customer_code}} — ทบทวนความต้องการและความพึงพอใจตามแผนบัญชี แล้วลงผลการทบทวน',
    variables: {
      customer_code: { label: 'รหัสลูกค้า', sample: 'CUS-OSD-000042' },
      customer_name: { label: 'ชื่อลูกค้า', sample: 'บริษัท ตัวอย่าง จำกัด' },
      review_on: { label: 'วันที่ครบรอบทบทวน', sample: '2026-10-06' },
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
  {
    eventType: 'crm.handover.submitted',
    label: 'ฝ่ายขายส่งมอบงานต่อ (ถึงหัวหน้าทีมที่รับ)',
    title: 'มีงานส่งมอบจากฝ่ายขาย: {{opportunity_code}}',
    body: '{{opportunity_title}} ({{customer_name}}) — {{sender_name}} ส่งมอบให้ทีม {{team_name}} รอรับงาน',
    variables: HANDOVER_VARIABLES,
  },
  {
    eventType: 'crm.handover.accepted',
    label: 'ทีมรับงานส่งมอบแล้ว (ถึงผู้ขาย)',
    title: 'ทีม {{team_name}} รับงาน {{opportunity_code}} แล้ว',
    body: '{{opportunity_title}} ({{customer_name}}) — รับโดย {{actor_name}}',
    variables: HANDOVER_VARIABLES,
  },
  {
    eventType: 'crm.handover.returned',
    label: 'งานส่งมอบถูกตีกลับ (ถึงผู้ขาย)',
    title: 'งานส่งมอบ {{opportunity_code}} ถูกตีกลับ',
    body: '{{opportunity_title}} — {{actor_name}} ทีม {{team_name}}: {{reason}}',
    variables: {
      ...HANDOVER_VARIABLES,
      reason: { label: 'เหตุผลที่ตีกลับ', sample: 'ยังไม่ระบุวันเริ่มติดตั้ง' },
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
