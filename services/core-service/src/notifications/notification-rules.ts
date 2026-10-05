/**
 * CD-53 — the reminder rules, in one place. Each rule used to keep its
 * threshold where its module happened to be (a constant in the contract
 * sweep, another in the KYC rules, a column on the CRM settings); a company
 * now sets all of them on one admin screen.
 *
 * The catalog is code: what a rule means and which parameters it takes. A
 * company's row (`notification_rules`) only switches it on or off and sets the
 * numbers; no row = the standard below. The wording of what gets sent is the
 * templates' business (CD-54), and the rule lists which templates it sends.
 */

export type RuleParamKind =
  /** One whole number of days. */
  | 'days'
  /** Several, each sent once — e.g. reminders at 60 and 30 days. */
  | 'days_list'
  /** CD-233 — several percentages, each sent once (e.g. 80, 100, 120 % of plan). */
  | 'percent_list';

export interface RuleParamDefinition {
  key: string;
  label: string;
  kind: RuleParamKind;
  min: number;
  max: number;
  /** A list holds at most this many steps. */
  maxItems?: number;
}

export interface RuleDefinition {
  code: string;
  /** The screen groups rules by this. */
  module: 'crm' | 'finance' | 'pm';
  label: string;
  description: string;
  /** Who receives it — shown on the screen, decided by the rule's code. */
  recipients: string;
  /** Templates (CD-54) this rule sends. */
  eventTypes: string[];
  params: RuleParamDefinition[];
  defaults: RuleParams;
}

export type RuleParams = Record<string, number | number[]>;

export interface EffectiveRule {
  code: string;
  enabled: boolean;
  params: RuleParams;
}

export const NOTIFICATION_RULES: readonly RuleDefinition[] = [
  {
    code: 'contract.renewal',
    module: 'crm',
    label: 'สัญญาใกล้หมดอายุ',
    description:
      'เปิดโอกาสการขายสำหรับต่ออายุก่อนวันสิ้นสุดสัญญา แล้วเตือนซ้ำตามจำนวนวันที่กำหนดขณะดีลยังไม่ปิด',
    recipients: 'เจ้าของสัญญา',
    eventTypes: ['crm.contract.renewal_opened', 'crm.contract.renewal_due'],
    params: [
      {
        key: 'open_days',
        label: 'เปิดดีลต่ออายุก่อนสิ้นสุด (วัน)',
        kind: 'days',
        min: 1,
        max: 365,
      },
      {
        key: 'remind_days',
        label: 'เตือนซ้ำเมื่อเหลือ (วัน)',
        kind: 'days_list',
        min: 1,
        max: 365,
        maxItems: 6,
      },
    ],
    defaults: { open_days: 90, remind_days: [60, 30] },
  },
  {
    code: 'invoice.overdue',
    module: 'finance',
    label: 'ใบแจ้งหนี้เลยกำหนดชำระ',
    description:
      'อ่านใบแจ้งหนี้ที่ยังค้างจาก SAP วันละครั้ง แล้วเตือนเมื่อเลยวันครบกำหนดตามจำนวนวันที่กำหนด (ใบละครั้งต่อขั้น)',
    recipients: 'ผู้ดูแลลูกค้า (account owner)',
    eventTypes: ['crm.invoice.overdue'],
    params: [
      {
        key: 'overdue_days',
        label: 'เตือนเมื่อเลยกำหนด (วัน)',
        kind: 'days_list',
        min: 1,
        max: 365,
        maxItems: 6,
      },
    ],
    defaults: { overdue_days: [30, 1] },
  },
  {
    code: 'kyc.expiry',
    module: 'crm',
    label: 'KYC ใกล้หมดอายุ',
    description:
      'เตือนล่วงหน้าก่อน KYC ของลูกค้าหมดอายุ (วันทบทวนหรือเอกสารหมดอายุ แล้วแต่อันไหนถึงก่อน) และแจ้งอีกครั้งในวันที่หมด',
    recipients: 'ผู้ดูแลลูกค้า (account owner)',
    eventTypes: ['crm.kyc.expiring', 'crm.kyc.expired'],
    params: [
      {
        key: 'warn_days',
        label: 'เตือนล่วงหน้า (วัน)',
        kind: 'days',
        min: 1,
        max: 365,
      },
    ],
    defaults: { warn_days: 30 },
  },
  {
    code: 'customer.review',
    module: 'crm',
    label: 'ถึงรอบทบทวนลูกค้าเดิม',
    description:
      'เตือนผู้ดูแลลูกค้าก่อนถึงรอบทบทวนตามแผนบัญชี (Keeper) — ทบทวนแล้วรอบถัดไปเลื่อนให้เอง',
    recipients: 'ผู้ดูแลลูกค้า (account owner)',
    eventTypes: ['crm.account.review_due'],
    params: [
      {
        key: 'warn_days',
        label: 'เตือนล่วงหน้า (วัน)',
        kind: 'days',
        min: 0,
        max: 60,
      },
    ],
    defaults: { warn_days: 7 },
  },
  {
    code: 'contract.expiry',
    module: 'crm',
    label: 'สัญญาที่ไม่ต่ออายุผ่านฝ่ายขายใกล้หมดอายุ',
    description:
      'NDA สัญญาอื่น ๆ และสัญญากับคู่สัญญาที่ไม่ใช่ลูกค้า — เตือนผู้รับผิดชอบสัญญาก่อนหมดอายุตามจำนวนวันที่กำหนด และแจ้งอีกครั้งในวันที่หมด (สัญญาลูกค้าใช้ "สัญญาใกล้หมดอายุ" ที่เปิดดีลต่ออายุ)',
    recipients: 'ผู้รับผิดชอบสัญญา',
    eventTypes: ['legal.contract.expiring', 'legal.contract.expired'],
    params: [
      {
        key: 'warn_days',
        label: 'เตือนเมื่อเหลือ (วัน)',
        kind: 'days_list',
        min: 1,
        max: 365,
        maxItems: 6,
      },
    ],
    defaults: { warn_days: [60, 30, 7] },
  },
  {
    code: 'esign.reminder',
    module: 'crm',
    label: 'เอกสารรอลงนาม — เตือนซ้ำและใกล้หมดอายุ',
    description:
      'เตือนผู้ลงนามที่ถึงลำดับแล้วแต่ยังไม่ลงนามทุก ๆ กี่วัน (ไม่เกินจำนวนครั้งที่กำหนด) และแจ้งผู้ส่งลงนามก่อนคำขอหมดอายุ — หมดอายุแล้วแจ้งผู้ส่งอีกครั้ง',
    recipients: 'ผู้ลงนามที่ยังไม่ลงนาม · ผู้ส่งลงนาม',
    eventTypes: ['esign.reminder', 'esign.expiring', 'esign.expired'],
    params: [
      {
        key: 'every_days',
        label: 'เตือนผู้ลงนามทุก (วัน)',
        kind: 'days',
        min: 1,
        max: 30,
      },
      {
        key: 'max_reminders',
        label: 'เตือนไม่เกิน (ครั้ง)',
        kind: 'days',
        min: 1,
        max: 10,
      },
      {
        key: 'warn_days',
        label: 'แจ้งผู้ส่งก่อนหมดอายุ (วัน)',
        kind: 'days',
        min: 0,
        max: 30,
      },
    ],
    defaults: { every_days: 2, max_reminders: 3, warn_days: 1 },
  },
  {
    code: 'contract.obligation',
    module: 'crm',
    label: 'ข้อผูกพันตามสัญญาใกล้ถึงกำหนด',
    description:
      'เตือนผู้รับผิดชอบข้อผูกพันก่อนถึงกำหนด และแจ้งอีกครั้งเมื่อเลยกำหนดแล้วยังไม่ทำ',
    recipients: 'ผู้รับผิดชอบข้อผูกพัน',
    eventTypes: ['legal.obligation.due', 'legal.obligation.overdue'],
    params: [
      {
        key: 'warn_days',
        label: 'เตือนล่วงหน้า (วัน)',
        kind: 'days',
        min: 0,
        max: 60,
      },
    ],
    defaults: { warn_days: 3 },
  },
  {
    code: 'phone.reservation',
    module: 'crm',
    label: 'เบอร์ที่จองใกล้หมดอายุ',
    description:
      'เตือนเจ้าของดีลก่อนการจองเลขหมาย (Reserve-phone) หมดอายุ และแจ้งเมื่อหมดแล้ว — ต่ออายุที่หน้าโอกาสการขาย',
    recipients: 'เจ้าของดีล',
    eventTypes: [
      'crm.phone_reservation.expiring',
      'crm.phone_reservation.expired',
    ],
    params: [
      {
        key: 'warn_days',
        label: 'เตือนล่วงหน้า (วัน)',
        kind: 'days',
        min: 1,
        max: 30,
      },
    ],
    defaults: { warn_days: 3 },
  },
  {
    code: 'opportunity.stale',
    module: 'crm',
    label: 'ดีลเงียบ',
    description:
      'เตือนเมื่อโอกาสการขายที่ยังเปิดอยู่ไม่มีกิจกรรมที่ทำเสร็จเกินจำนวนวันที่กำหนด',
    recipients: 'เจ้าของดีล + หัวหน้าที่ใกล้ที่สุด',
    eventTypes: ['crm.opportunity.stale'],
    params: [
      {
        key: 'days',
        label: 'ไม่มีกิจกรรมเกิน (วัน)',
        kind: 'days',
        min: 1,
        max: 365,
      },
    ],
    defaults: { days: 14 },
  },
  {
    code: 'manday.variance',
    module: 'pm',
    label: 'Manday ใช้จริงเกินแผน',
    description:
      'ตรวจวันละครั้ง: manday จาก Timesheet ที่อนุมัติแล้วถึงร้อยละที่กำหนดของ manday ในงบโครงการที่ล็อกล่าสุด — แจ้งครั้งเดียวต่อขั้นต่อเวอร์ชันงบ และสรุปส่วนต่างสุดท้ายเมื่อปิดโครงการ',
    recipients:
      'ผู้จัดการโครงการ และผู้มีสิทธิ์ดูแลราคา (pricing.price.manage)',
    eventTypes: ['hr.manday.threshold', 'hr.manday.closed'],
    params: [
      {
        key: 'percents',
        label: 'แจ้งเมื่อใช้ไปถึง (% ของแผน)',
        kind: 'percent_list',
        min: 10,
        max: 500,
        maxItems: 5,
      },
    ],
    defaults: { percents: [120, 100, 80] },
  },
  {
    code: 'delivery.readiness',
    module: 'pm',
    label: 'ของยังไม่พร้อมก่อนวันส่งมอบ',
    description:
      'รอบส่งมอบที่ใกล้ถึงวันตามแผนแต่ยังมีบรรทัดที่ของไม่พร้อม (หรือยังไม่ทราบ) — แจ้งครั้งเดียวต่อวันที่ตามแผน เลื่อนวันแล้วแจ้งใหม่',
    recipients: 'ผู้จัดการโครงการ และทีม Delivery (delivery.manage)',
    eventTypes: ['delivery.not_ready'],
    params: [
      {
        key: 'days',
        label: 'แจ้งเมื่อเหลือไม่เกิน (วันก่อนวันส่ง)',
        kind: 'days',
        min: 1,
        max: 60,
      },
    ],
    defaults: { days: 7 },
  },
  {
    code: 'retention.release',
    module: 'pm',
    label: 'ใกล้คืนเงินประกันผลงาน',
    description:
      'สัญญาที่มีงวดคืนเงินประกันผลงาน — เตือนก่อนระยะประกันสิ้นสุดตามจำนวนวันที่กำหนด ให้เตรียมคำขอคืนเงินประกัน (ครั้งเดียวต่อวันสิ้นสุดประกัน)',
    recipients: 'ผู้จัดการโครงการ และทีม Delivery (delivery.manage)',
    eventTypes: ['delivery.retention_due'],
    params: [
      {
        key: 'days',
        label: 'เตือนก่อนประกันสิ้นสุด (วัน)',
        kind: 'days',
        min: 1,
        max: 180,
      },
    ],
    defaults: { days: 30 },
  },
  {
    code: 'service.handover',
    module: 'pm',
    label: 'ส่งมอบให้ทีมบริการยังไม่รับทราบ',
    description:
      'งานที่ทีม Delivery ส่งต่อให้ทีมบริการหลังตรวจรับแล้ว แต่ทีมบริการยังไม่กดรับทราบ — เตือนซ้ำทุกจำนวนวันที่กำหนดจนกว่าจะรับทราบ',
    recipients: 'ทีมบริการ (service.asset.manage)',
    eventTypes: ['delivery.handover_overdue'],
    params: [
      {
        key: 'days',
        label: 'เตือนเมื่อค้างเกิน (วัน)',
        kind: 'days',
        min: 1,
        max: 30,
      },
    ],
    defaults: { days: 3 },
  },
  {
    code: 'receivable.overdue',
    module: 'finance',
    label: 'งวดค้างชำระ',
    description:
      'งวดที่วางบิลแล้วเลยกำหนดชำระ (วันออกใบแจ้งหนี้ + เครดิต 30 วัน) แต่ยังไม่ได้รับเงิน — สรุปส่งพนักงานขายเจ้าของสัญญา (เฉพาะของตัวเอง) และฝ่ายการเงิน (ทุกสัญญา) ซ้ำทุกจำนวนวันที่กำหนด',
    recipients:
      'เจ้าของสัญญา (ฝ่ายขาย) และฝ่ายการเงิน (delivery.receivable.read)',
    eventTypes: ['delivery.receivables_overdue'],
    params: [
      {
        key: 'days',
        label: 'ส่งสรุปซ้ำทุก (วัน)',
        kind: 'days',
        min: 1,
        max: 30,
      },
    ],
    defaults: { days: 7 },
  },
];

const BY_CODE = new Map(NOTIFICATION_RULES.map((rule) => [rule.code, rule]));

export function ruleOf(code: string): RuleDefinition | undefined {
  return BY_CODE.get(code);
}

/**
 * What a saved row means today: its numbers where they are still valid, the
 * standard where not. A stored value the catalog has since narrowed must not
 * crash a sweep — it falls back, and the screen shows the fallback.
 */
export function effectiveRule(
  definition: RuleDefinition,
  row: { enabled: boolean; params: unknown } | null | undefined,
): EffectiveRule {
  if (!row) {
    return {
      code: definition.code,
      enabled: true,
      params: { ...definition.defaults },
    };
  }
  const stored =
    row.params && typeof row.params === 'object'
      ? (row.params as Record<string, unknown>)
      : {};
  const params: RuleParams = {};
  for (const param of definition.params) {
    const value = normalizeParam(param, stored[param.key]);
    params[param.key] =
      value !== null && paramProblem(param, value) === null
        ? value
        : definition.defaults[param.key];
  }
  const problem = crossProblem(definition, params);
  return {
    code: definition.code,
    enabled: row.enabled,
    params: problem ? { ...definition.defaults } : params,
  };
}

/**
 * Problems with a submitted rule, in Thai, first one first. An empty list is
 * valid. Lists come back sorted largest first and de-duplicated.
 */
export function ruleProblems(
  definition: RuleDefinition,
  input: Record<string, unknown>,
): { problems: string[]; params: RuleParams } {
  const problems: string[] = [];
  const params: RuleParams = {};
  const known = new Set(definition.params.map((param) => param.key));
  for (const key of Object.keys(input)) {
    if (!known.has(key)) problems.push(`ไม่รู้จักค่า ${key} ของกติกานี้`);
  }
  for (const param of definition.params) {
    const raw = input[param.key];
    if (raw === undefined) {
      params[param.key] = definition.defaults[param.key];
      continue;
    }
    const value = normalizeParam(param, raw);
    const problem =
      value === null
        ? `${param.label}: รูปแบบไม่ถูกต้อง`
        : paramProblem(param, value);
    if (problem) problems.push(problem);
    else params[param.key] = value as number | number[];
  }
  if (!problems.length) {
    const problem = crossProblem(definition, params);
    if (problem) problems.push(problem);
  }
  return { problems, params };
}

function normalizeParam(
  param: RuleParamDefinition,
  raw: unknown,
): number | number[] | null {
  if (param.kind === 'days') {
    return typeof raw === 'number' && Number.isInteger(raw) ? raw : null;
  }
  if (!Array.isArray(raw)) return null;
  if (!raw.every((item) => typeof item === 'number' && Number.isInteger(item)))
    return null;
  return [...new Set(raw as number[])].sort((a, b) => b - a);
}

function paramProblem(
  param: RuleParamDefinition,
  value: number | number[],
): string | null {
  const values = Array.isArray(value) ? value : [value];
  if (Array.isArray(value)) {
    if (!value.length) return `${param.label}: ต้องมีอย่างน้อย 1 ค่า`;
    if (param.maxItems && value.length > param.maxItems)
      return `${param.label}: ได้ไม่เกิน ${param.maxItems} ค่า`;
  }
  for (const item of values) {
    if (item < param.min || item > param.max)
      return `${param.label}: ต้องอยู่ระหว่าง ${param.min}–${param.max}`;
  }
  return null;
}

/** Rules whose parameters constrain each other. */
function crossProblem(
  definition: RuleDefinition,
  params: RuleParams,
): string | null {
  if (definition.code === 'contract.renewal') {
    const open = params.open_days as number;
    const remind = params.remind_days as number[];
    if (remind.some((days) => days >= open)) {
      return 'วันเตือนซ้ำต้องน้อยกว่าวันที่เปิดดีลต่ออายุ';
    }
  }
  return null;
}
