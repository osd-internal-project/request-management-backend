/**
 * `SOP_DOCREQ` — การขอใช้เอกสารสำคัญของบริษัท (ภายในองค์กร), from
 * `source/request type docs/SOP-BSD-DOCREQ/SOP-BSD-DOCREQ.docx`. Shaped like
 * `PublishFlowDto` (schema v2); published by `seed-sop-docreq-type.ts`.
 */

/** The eight documents in the SOP's register table. */
export const SOP_DOCUMENTS = [
  'หนังสือรับรองบริษัท',
  'หนังสือบริคณห์สนธิ',
  'บัญชีรายชื่อผู้ถือหุ้น (บอจ.5)',
  'ใบทะเบียนภาษีมูลค่าเพิ่ม (ภ.พ.20)',
  'สำเนาบัตรประชาชนกรรมการ',
  'ทะเบียนบ้านกรรมการผู้มีอำนาจ',
  'ใบอนุญาตประกอบกิจการเฉพาะทาง (เช่น กสทช.)',
  'BookBank',
];

/** SOP ข้อ 3; request no., date and requester are issued by the system. */
export const SOP_DOCREQ_FORM = {
  type: 'object',
  required: [
    'documents',
    'includes_company_cert',
    'counterparty_type',
    'counterparty_name',
    'purpose',
    'watermark_text',
    'needed_by',
  ],
  properties: {
    documents: {
      type: 'array',
      title: 'รายการเอกสารที่ขอ',
      maxItems: SOP_DOCUMENTS.length,
      'x-order': 10,
      items: {
        type: 'object',
        required: ['document', 'copies'],
        properties: {
          document: {
            type: 'string',
            title: 'เอกสาร',
            enum: SOP_DOCUMENTS,
            'x-order': 10,
          },
          copies: {
            type: 'integer',
            title: 'จำนวนชุด',
            minimum: 1,
            'x-order': 20,
          },
        },
      },
    },
    // Flow conditions cannot read inside `documents`, so the certificate branch needs a flag.
    includes_company_cert: {
      type: 'boolean',
      title: 'รายการที่ขอมีหนังสือรับรองบริษัท',
      'x-order': 20,
    },
    cert_valid_days: {
      type: 'integer',
      title:
        'หนังสือรับรองต้องมีอายุไม่เกินกี่วัน นับจากวันที่เอกสาร (ไม่เกิน 30 วัน)',
      minimum: 1,
      maximum: 30,
      'x-order': 30,
    },
    counterparty_type: {
      type: 'string',
      title: 'ประเภทผู้รับเอกสาร',
      enum: ['Vendor', 'Customer', 'Other'],
      'x-order': 40,
    },
    counterparty_name: {
      type: 'string',
      title: 'ชื่อผู้รับเอกสาร',
      maxLength: 200,
      'x-order': 50,
    },
    purpose: {
      type: 'string',
      title: 'วัตถุประสงค์ในการใช้เอกสาร',
      maxLength: 2000,
      'x-multiline': true,
      'x-order': 60,
    },
    watermark_text: {
      type: 'string',
      title: 'ข้อความที่ต้องการคาด',
      maxLength: 500,
      'x-order': 70,
    },
    needed_by: {
      type: 'string',
      format: 'date',
      title: 'วันที่ต้องการใช้เอกสาร',
      'x-order': 80,
    },
  },
};

const PREPARE_FORM = {
  type: 'object',
  required: ['files_located', 'cert_requested'],
  properties: {
    files_located: {
      type: 'boolean',
      title: 'พบไฟล์ฉบับล่าสุดใน Folder เอกสารบริษัทครบทุกรายการ',
      'x-order': 10,
    },
    // The custodian's word, not the requester's tick, decides the certificate branch.
    cert_requested: {
      type: 'boolean',
      title: 'รายการที่ขอมีหนังสือรับรองบริษัท',
      'x-order': 20,
    },
    note: {
      type: 'string',
      title: 'หมายเหตุ',
      maxLength: 2000,
      'x-multiline': true,
      'x-order': 30,
    },
  },
};

const CERT_CHECK_FORM = {
  type: 'object',
  required: ['cert_document_date', 'cert_usable'],
  properties: {
    cert_document_date: {
      type: 'string',
      format: 'date',
      title: 'วันที่ของหนังสือรับรองฉบับล่าสุด',
      'x-order': 10,
    },
    cert_usable: {
      type: 'boolean',
      title: 'วันที่เอกสาร + จำนวนวันที่ขอ ไม่เกินวันที่ต้องการใช้ (ใช้ได้)',
      'x-true-label': 'ใช้ได้',
      'x-false-label': 'ต้องคัดใหม่',
      'x-order': 20,
    },
    note: {
      type: 'string',
      title: 'หมายเหตุ',
      maxLength: 2000,
      'x-multiline': true,
      'x-order': 30,
    },
  },
};

const CERT_REISSUE_FORM = {
  type: 'object',
  required: ['new_cert_date', 'uploaded_to_folder'],
  properties: {
    new_cert_date: {
      type: 'string',
      format: 'date',
      title: 'วันที่ของหนังสือรับรองฉบับใหม่',
      'x-order': 10,
    },
    uploaded_to_folder: {
      type: 'boolean',
      title: 'อัปโหลดเข้า Folder และบันทึกทะเบียนแล้ว (SOP ข้อ 1–2)',
      'x-order': 20,
    },
  },
};

const STAMP_DELIVER_FORM = {
  type: 'object',
  required: ['delivered_on', 'copies_delivered'],
  properties: {
    delivered_on: {
      type: 'string',
      format: 'date',
      title: 'วันที่ส่งเอกสารให้ผู้ขอ',
      'x-order': 10,
    },
    copies_delivered: {
      type: 'integer',
      title: 'จำนวนชุดที่ส่ง',
      minimum: 1,
      'x-order': 20,
    },
    note: {
      type: 'string',
      title: 'หมายเหตุ',
      maxLength: 2000,
      'x-multiline': true,
      'x-order': 30,
    },
  },
};

/** SOP ข้อ 3–6 as v2 steps: approve → receive → prepare → [cert check → reissue] → stamp → confirm. */
export const SOP_DOCREQ_FLOW = {
  schema_version: 2 as const,
  steps: [
    {
      code: 'REQUEST',
      name: 'ยื่นคำขอ',
      scope_status: 'draft' as const,
      form_schema: SOP_DOCREQ_FORM,
    },
    {
      code: 'SUPERVISOR_APPROVAL',
      name: 'หัวหน้างานอนุมัติ',
      scope_status: 'pending_approval' as const,
      approval_levels: [
        { type: 'supervisor' as const, up: 1, chartOf: 'requester' as const },
      ],
      return_to_step: 'REQUEST',
    },
    {
      code: 'RECEIVE',
      name: 'ผู้ดูแลเอกสารตรวจวัตถุประสงค์',
      scope_status: 'submitted' as const,
    },
    {
      code: 'PREPARE',
      name: 'ค้นไฟล์เอกสารล่าสุด',
      scope_status: 'in_progress' as const,
      form_schema: PREPARE_FORM,
    },
    {
      code: 'CERT_CHECK',
      name: 'ตรวจวันที่หนังสือรับรอง',
      scope_status: 'in_progress' as const,
      form_schema: CERT_CHECK_FORM,
    },
    {
      code: 'CERT_REISSUE',
      name: 'คัดหนังสือรับรองใหม่',
      scope_status: 'in_progress' as const,
      form_schema: CERT_REISSUE_FORM,
      sla_hours: 8,
    },
    {
      code: 'STAMP_DELIVER',
      name: 'คาดข้อความ ปริ้น และส่งเอกสาร',
      scope_status: 'in_progress' as const,
      form_schema: STAMP_DELIVER_FORM,
    },
    {
      code: 'SIGNED_CONFIRM',
      name: 'แนบเอกสารที่ลงนามแล้ว ยืนยันจบงาน',
      scope_status: 'approved' as const,
      required_docs: [
        {
          code: 'SIGNED_DOCUMENT',
          name: 'เอกสารที่ลงนามเรียบร้อย',
          required: true,
        },
      ],
    },
  ],
  transitions: [
    { from_step: 'REQUEST', to_step: 'SUPERVISOR_APPROVAL' },
    { from_step: 'SUPERVISOR_APPROVAL', to_step: 'RECEIVE' },
    { from_step: 'RECEIVE', to_step: 'PREPARE' },
    { from_step: 'RECEIVE', to_step: 'REQUEST', backward: true },
    {
      from_step: 'PREPARE',
      to_step: 'CERT_CHECK',
      condition: { field: 'cert_requested', op: 'eq' as const, value: true },
    },
    { from_step: 'PREPARE', to_step: 'STAMP_DELIVER' },
    {
      from_step: 'CERT_CHECK',
      to_step: 'CERT_REISSUE',
      condition: { field: 'cert_usable', op: 'eq' as const, value: false },
    },
    { from_step: 'CERT_CHECK', to_step: 'STAMP_DELIVER' },
    // No loop back to CERT_CHECK: forward cycles are refused, so the new date is recorded here.
    { from_step: 'CERT_REISSUE', to_step: 'STAMP_DELIVER' },
    { from_step: 'STAMP_DELIVER', to_step: 'SIGNED_CONFIRM' },
    { from_step: 'STAMP_DELIVER', to_step: 'PREPARE', backward: true },
  ],
};
