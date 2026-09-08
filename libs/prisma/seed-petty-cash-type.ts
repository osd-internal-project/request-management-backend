/**
 * The `FI05` request type — ขอเบิกเงินทดรองจ่าย (Petty Cash / Advance).
 *
 *   yarn petty:seed
 *
 * Idempotent; safe to re-run.
 *
 * Its own script for the same two reasons `seed-presales-type.ts` is one: the
 * demo seed deliberately excludes OSD, and the catalog importer writes every
 * type from the spreadsheet with one shared placeholder schema. The form below
 * is hand-written from the screens in `source/petty cash flow ui /` — step 1
 * (`1_สร้างรายการ.png`) is the requester's form, step 4
 * (`4_บัญชีตรวจสอบ_รออนุมัติผ่านLINE.png`) is the receiver's.
 *
 * The catalog's finance block runs `FI-01`..`FI-04`; this is a new code rather
 * than a rewrite of `FI-01` (ขอเบิกค่าใช้จ่าย / ตั้งเบิก), which is
 * reimbursement of money already spent. An advance is the opposite direction
 * and clears against receipts later, so it is a different type with a
 * different form. `FI-05` is absent from `10_LIST_REQUEST_TYPE`, so the
 * importer's `/^[A-Z]{2}-\d{2}$/` loop never reaches it and no skip-list entry
 * is needed.
 *
 * **One approval ladder, before the work.** The requester's own head approves
 * (`request:FI05:pre`, `{type:'supervisor', up:1}`) — screens 2 and 3 of the
 * flow. Approval lands the request back on `submitted` and Accounting then
 * receives it. The executive's LINE approval on screen 4 is a *second*,
 * after-work ladder and is deliberately **not** published here: adding it is
 * publishing a matrix for `request:FI05`, no code change.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const COMPANY_CODE = 'OSD';
const CODE = 'FI05';
/** `FAC` — บัญชีและการเงิน, where the AP officers sit. */
const RECEIVER_UNIT_CODE = 'FAC';
/** The finance block's SLA column reads 3 days, counted in office hours. */
const SLA_DAYS = 3;
const HOURS_PER_DAY = 24;
const MATRIX_SUBJECT = `request:${CODE}:pre`;

/**
 * Screen 1's "ข้อมูลผู้ขอเบิกเงินทดรอง", minus what the request already owns.
 *
 * เลขที่เอกสาร, วันที่ขอ and ผู้ขอ are on the screen but not here: they are
 * `requestNo`, `submittedAt` and `requesterId`, issued by the system at submit.
 * Repeating them in the form would let a caller send a document number that
 * disagrees with the one the counter hands out.
 *
 * The SO block is optional on the screen ("ข้อมูลอ้างอิง SO (ไม่บังคับ)") and
 * optional here. It is left as form fields rather than `refType`/`refId`
 * because the screen carries four separate references — SO, ticket, project
 * and an originating request — and that column pair holds one.
 */
const FORM_SCHEMA = {
  type: 'object',
  required: [
    'requester_department',
    'cost_center',
    'payee',
    'needed_by',
    'clear_by',
    'purpose',
    'expense_items',
  ],
  properties: {
    requester_department: {
      type: 'string',
      title: 'แผนก',
      maxLength: 120,
      'x-order': 10,
    },
    cost_center: {
      type: 'string',
      title: 'Cost Center',
      maxLength: 60,
      'x-order': 20,
    },
    payee: {
      type: 'string',
      title: 'ผู้รับเงิน',
      maxLength: 120,
      'x-order': 30,
    },
    needed_by: {
      type: 'string',
      format: 'date',
      title: 'วันที่ต้องการใช้เงิน',
      'x-order': 40,
    },
    /*
      The date the advance must be cleared against receipts. Screen 1 warns
      that unspent money is returned and an overspend is claimed back at the
      clearing step, so this is not a nice-to-have — it is the date the whole
      obligation hangs on, and it is required.
    */
    clear_by: {
      type: 'string',
      format: 'date',
      title: 'กำหนดส่งเคลียร์ภายใน',
      'x-order': 50,
    },
    purpose: {
      type: 'string',
      title: 'วัตถุประสงค์การเบิกเงินทดรอง',
      maxLength: 2000,
      'x-multiline': true,
      'x-order': 60,
    },
    remark: {
      type: 'string',
      title: 'หมายเหตุ',
      maxLength: 2000,
      'x-multiline': true,
      'x-order': 70,
    },
    so_no: { type: 'string', title: 'เลขที่ SO', maxLength: 60, 'x-order': 80 },
    so_subject: {
      type: 'string',
      title: 'Subject SO',
      maxLength: 200,
      'x-order': 90,
    },
    ticket_no: {
      type: 'string',
      title: 'Ticket No.',
      maxLength: 60,
      'x-order': 100,
    },
    project_code: {
      type: 'string',
      title: 'Project',
      maxLength: 60,
      'x-order': 110,
    },
    /*
      "รายละเอียดค่าใช้จ่ายโดยประมาณ" — the table that produces the amount.

      A table rather than a single `amount` field because the screen totals the
      rows and the accountant checks each line against its cost centre. The
      total itself is not stored: it is the sum of `amount`, and a stored copy
      is one edit away from disagreeing with the rows it claims to total.

      `maxItems` matches nothing on the screen — the screen has no cap — but
      `assertSubmittable` reports one failure per empty required cell, and an
      unbounded table is an unbounded error response.
    */
    expense_items: {
      type: 'array',
      title: 'รายละเอียดค่าใช้จ่ายโดยประมาณ',
      maxItems: 20,
      'x-order': 120,
      items: {
        type: 'object',
        required: ['description', 'cost_center', 'amount'],
        properties: {
          description: {
            type: 'string',
            title: 'รายการค่าใช้จ่าย',
            maxLength: 200,
            'x-order': 10,
          },
          cost_center: {
            type: 'string',
            title: 'Cost Center',
            maxLength: 60,
            'x-order': 20,
          },
          amount: {
            type: 'number',
            title: 'จำนวนเงิน (บาท)',
            'x-order': 30,
          },
          note: {
            type: 'string',
            title: 'หมายเหตุ',
            maxLength: 200,
            'x-order': 40,
          },
        },
      },
    },
  },
};

/**
 * Screen 4's "การตรวจสอบของบัญชี" and "ความเห็นของบัญชี".
 *
 * **The three checks are required but cannot be enforced true.**
 * `assertReceiverFormComplete` rejects a blank field, and `isBlank` treats
 * `false` as present on purpose (a `0` or a `false` is an answer). So a caller
 * may send `false` and pass. They are listed in `required` because that is
 * what puts them in front of whoever fills the form in — a chatbot reads
 * `required` to decide what to ask — and the truth of each tick is the
 * accountant's statement, which no schema can check anyway.
 */
const RECEIVER_FORM_SCHEMA = {
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
 * Empty, and that is the screen.
 *
 * "เอกสารประกอบ (ใบเสนอราคา / แผนงาน ถ้ามี)" — *ถ้ามี*. Naming a code here
 * would make `assertSubmittable` refuse every request raised through the
 * external API, which has no way to attach a file.
 */
const REQUIRED_DOCS: { code: string; name: string }[] = [];

const RETURN_REASON_CODES = [
  { code: 'INFO_INCOMPLETE', name: 'ข้อมูลไม่ครบ' },
  { code: 'DOC_MISSING', name: 'เอกสารประกอบไม่ครบ' },
  { code: 'COST_CENTER_INVALID', name: 'Cost Center หรืองบประมาณไม่ถูกต้อง' },
  { code: 'AMOUNT_EXCEEDS_LIMIT', name: 'วงเงินเกินอำนาจอนุมัติ' },
  { code: 'CLEAR_DATE_UNREALISTIC', name: 'กำหนดส่งเคลียร์ไม่สมเหตุสมผล' },
  { code: 'OTHER', name: 'อื่น ๆ (ระบุ)' },
];

async function seedPettyCashType(): Promise<void> {
  const company = await prisma.company.findUnique({
    where: { code: COMPANY_CODE },
  });

  if (!company) {
    throw new Error(
      `No company "${COMPANY_CODE}". Run \`yarn prisma:seed\` first.`,
    );
  }

  const receiverUnit = await prisma.orgUnit.findFirst({
    where: { companyId: company.id, code: RECEIVER_UNIT_CODE },
  });

  /*
    Reported, not fatal — same call as `seed-presales-type.ts`. The requester
    names a receiver on every request anyway, so a type with no default
    receiving team is usable; refusing to seed would make this script depend on
    the org chart having been imported first.
  */
  if (!receiverUnit) {
    console.warn(
      `  warning: no org unit "${RECEIVER_UNIT_CODE}" in ${COMPANY_CODE};` +
        ' the type is seeded with no default receiving team, and' +
        ' receiver_candidates will come back empty.',
    );
  }

  const data = {
    name: 'ขอเบิกเงินทดรองจ่าย (Petty Cash / Advance)',
    receiverOrgUnitId: receiverUnit?.id ?? null,
    formSchema: FORM_SCHEMA,
    receiverFormSchema: RECEIVER_FORM_SCHEMA,
    requiredDocs: REQUIRED_DOCS,
    returnReasonCodes: RETURN_REASON_CODES,
    // Vestigial since routing moved to the matrix; see `seed-presales-type.ts`.
    approvalPolicy: {},
    slaHours: SLA_DAYS * HOURS_PER_DAY,
    slaCoverage: 'H8X5' as const,
    active: true,
  };

  const saved = await prisma.requestType.upsert({
    where: { code: CODE },
    update: { ...data, updatedBy: 'petty-cash-seed' },
    create: { code: CODE, ...data, createdBy: 'petty-cash-seed' },
  });

  await prisma.requestTypeCompany.upsert({
    where: {
      requestTypeId_companyId: {
        requestTypeId: saved.id,
        companyId: company.id,
      },
    },
    update: { active: true },
    create: { requestTypeId: saved.id, companyId: company.id, active: true },
  });

  /*
    No `RequestTypeOrgUnit` rows, deliberately: anybody may ask for an advance.
    No rows means everybody, so writing none is the configuration — adding one
    row would silently restrict the type to that single unit.
  */
  await prisma.requestTypeOrgUnit.deleteMany({
    where: { requestTypeId: saved.id },
  });

  const matrix = await publishPreApprovalMatrix(company.id);

  console.log(`  ${CODE} · ${data.name}`);
  console.log(`  company: ${COMPANY_CODE}`);
  console.log(
    `  receiving team: ${receiverUnit ? receiverUnit.name : '(none)'}`,
  );
  console.log('  who may raise it: everyone (no org-unit restriction)');
  console.log(`  SLA: ${SLA_DAYS} วัน (H8X5)`);
  console.log(`  approval: ${matrix}`);
}

/**
 * The before-work ladder: the requester's own head, and nobody else.
 *
 * Published on creation — a matrix with a null `publishedAt` is inert and
 * `findEffective` never returns it, so seeding a draft would look like an
 * approval that silently never happens.
 *
 * Left alone if one already exists. Published matrices are immutable by
 * design (§8): re-running this script must not rewrite a ladder that requests
 * in flight were routed against.
 */
async function publishPreApprovalMatrix(companyId: string): Promise<string> {
  const existing = await prisma.approvalMatrix.findFirst({
    where: { companyId, subjectType: MATRIX_SUBJECT },
  });

  if (existing) {
    return `${MATRIX_SUBJECT} v${existing.version} already published, left alone`;
  }

  await prisma.approvalMatrix.create({
    data: {
      companyId,
      subjectType: MATRIX_SUBJECT,
      currency: 'THB',
      version: 1,
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
      publishedAt: new Date('2026-01-01T00:00:00Z'),
      /*
        `up: 1` is the nearest head above where the requester sits. The OSD
        chart runs COMPANY → DIVISION → DEPARTMENT → POSITION and people sit at
        POSITION, which has no head of its own; `supervisorAt` climbs past a
        headless group rather than failing, so this resolves to the department
        manager — "หัวหน้าผู้ขอ ระดับแผนก" on screens 2 and 3.
      */
      levels: [{ type: 'supervisor', up: 1 }],
      // NOT NULL and read by nothing; see the note on `ApprovalMatrix.tiers`.
      tiers: [{ upto: null, chain: ['department_manager'] }],
      createdBy: 'petty-cash-seed',
    },
  });

  return `${MATRIX_SUBJECT} v1 · หัวหน้าผู้ขอ (ก่อนเริ่มงาน)`;
}

seedPettyCashType()
  .then(() => console.log('Done.'))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
