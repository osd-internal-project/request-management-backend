/**
 * FI05 / FI06 as flow-v2 tickets: asked, approved by the head and the executive, received by
 * accounting — then the disbursement is created at the work step and the request waits there
 * until it closes. Published by `seed-disbursement-flows.ts`. docs/disbursement.md
 */

/**
 * Step codes in `disbursement_settings`. `payStep` / `clearStep` name the steps of the flow
 * before v3: a request on such a version still pays and clears through its own steps.
 */
export const WORK_STEPS = {
  verifyStep: 'VERIFY',
  execStep: 'EXEC',
  payStep: 'PAY',
  clearStep: 'CLEAR',
  doneStep: 'DONE',
} as const;

/** The request's work step: the disbursement is created on entering it and closing it moves on. */
export const WORK_STEP = 'DISBURSE';

/** What the disbursement reads from the request form (`x-bind: "disbursement.<path>"`). */
export const DISBURSEMENT_BINDINGS: Readonly<Record<string, string>> = {
  payee: 'payee',
  cost_center: 'cost_center',
  purpose: 'purpose',
  needed_by: 'needed_by',
  clear_by: 'clear_by',
  so_no: 'so_no',
  so_subject: 'so_subject',
  ticket_no: 'ticket_no',
  project_code: 'project_code',
  lines: 'expense_items',
  'lines.description': 'description',
  'lines.cost_center': 'cost_center',
  'lines.amount': 'amount',
  'lines.note': 'note',
  'lines.receipt_date': 'receipt_date',
};

/** The paths a FI05 / FI06 form must keep tagged, or the admin cannot save it. */
export function requiredBindings(kind: 'ADVANCE' | 'PETTY_CASH'): readonly string[] {
  const base = ['purpose', 'lines', 'lines.description', 'lines.amount'];
  return kind === 'ADVANCE' ? [...base, 'clear_by'] : base;
}

type Json = Record<string, unknown>;
const asJson = (value: unknown): Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : {};

/** The request form with `x-bind` tags, and Cost Center fields picking from the master list. */
export function withDisbursementBindings(form: unknown): Json {
  const schema = structuredClone(asJson(form));
  const props = asJson(schema.properties);
  const tag = (property: Json, path: string) => {
    property['x-bind'] = `disbursement.${path}`;
    if (path.endsWith('cost_center')) property['x-options-source'] = 'cost_centers';
  };
  for (const [path, key] of Object.entries(DISBURSEMENT_BINDINGS)) {
    const [field, column] = path.split('.');
    const fieldKey = DISBURSEMENT_BINDINGS[field];
    const property = asJson(props[fieldKey]);
    if (!Object.keys(property).length) continue;
    if (!column) {
      tag(property, path);
      continue;
    }
    const cell = asJson(asJson(asJson(property.items).properties)[key]);
    if (Object.keys(cell).length) tag(cell, path);
  }
  return schema;
}

/** Screen 4 — the accountant's checks; same keys the disbursement records. */
export const VERIFY_FORM = {
  type: 'object',
  required: [
    'checked_cost_center',
    'checked_documents',
    'checked_authority',
    'note',
  ],
  properties: {
    checked_cost_center: {
      type: 'boolean',
      title: 'ตรวจสอบ Cost Center และงบประมาณคงเหลือเรียบร้อย',
      'x-order': 10,
    },
    checked_documents: {
      type: 'boolean',
      title: 'ตรวจสอบเอกสารประกอบครบถ้วนถูกต้อง',
      'x-order': 20,
    },
    checked_authority: {
      type: 'boolean',
      title:
        'ตรวจสอบวงเงินขออนุมัติตรงตามระดับอำนาจอนุมัติ (Authorization Matrix)',
      'x-order': 30,
    },
    note: {
      type: 'string',
      title: 'ความเห็นของบัญชี',
      maxLength: 2000,
      'x-multiline': true,
      'x-order': 40,
    },
  },
};

/**
 * `financeUnitId` heads the executive step — proposed, not in the source
 * (screen 4b only names the CFO); change it in the flow builder.
 * PETTY_CASH has no executive step: its head approves alone (user, 9 Oct 2026).
 */
export function disbursementFlow(
  kind: 'ADVANCE' | 'PETTY_CASH',
  requestForm: unknown,
  financeUnitId: string,
) {
  const advance = kind === 'ADVANCE';
  return {
    schema_version: 2 as const,
    steps: [
      {
        code: 'REQUEST',
        name: advance ? 'ขอเบิกเงินทดรอง' : 'ขอเบิกเงินสดย่อย',
        scope_status: 'draft' as const,
        form_schema: withDisbursementBindings(requestForm),
      },
      {
        code: 'HEAD',
        name: 'หัวหน้างานอนุมัติ',
        scope_status: 'pending_approval' as const,
        approval_levels: [
          { type: 'supervisor' as const, up: 1, chartOf: 'requester' as const },
        ],
        return_to_step: 'REQUEST',
      },
      ...(advance
        ? [
            {
              code: WORK_STEPS.execStep,
              name: 'ผู้บริหารอนุมัติ',
              scope_status: 'pending_approval' as const,
              approval_levels: [
                { type: 'org' as const, orgUnitIds: [financeUnitId] },
              ],
              return_to_step: 'REQUEST',
            },
          ]
        : []),
      {
        code: 'RECEIVE',
        name: 'บัญชีรับเรื่อง',
        scope_status: 'submitted' as const,
      },
      // Entering it creates the disbursement; accounting checks, pays and closes there.
      {
        code: WORK_STEP,
        name: advance
          ? 'ดำเนินการเบิก (ตรวจ · จ่าย · เคลียร์ · ปิด)'
          : 'ดำเนินการเบิก (ตรวจ · จ่าย · ปิด)',
        scope_status: 'in_progress' as const,
      },
      {
        code: WORK_STEPS.doneStep,
        name: 'ปิดรายการ',
        scope_status: 'approved' as const,
      },
    ],
    transitions: [
      { from_step: 'REQUEST', to_step: 'HEAD' },
      ...(advance
        ? [
            { from_step: 'HEAD', to_step: WORK_STEPS.execStep },
            { from_step: WORK_STEPS.execStep, to_step: 'RECEIVE' },
          ]
        : [{ from_step: 'HEAD', to_step: 'RECEIVE' }]),
      { from_step: 'RECEIVE', to_step: WORK_STEP },
      { from_step: 'RECEIVE', to_step: 'REQUEST', backward: true },
      { from_step: WORK_STEP, to_step: WORK_STEPS.doneStep },
    ],
  };
}
