/**
 * The `PS01` request type — ขอ Pre-Sales / Solution Design.
 *
 *   yarn presales:seed
 *
 * Idempotent; safe to re-run.
 *
 * Its own script rather than a row in `seed.ts` or in the catalog importer,
 * for two different reasons:
 *
 *   - `seed.ts` invents `DSC` and `LEAD` for demo companies and deliberately
 *     excludes `OSD`. This type is real and belongs to OSD.
 *   - `import-osd-catalog.ts` writes all forty types from the spreadsheet with
 *     one shared placeholder schema. Re-running it would overwrite the form
 *     below, so `PS01` is on that script's skip list — see
 *     `HAND_WRITTEN_SCHEMAS` there.
 *
 * The catalog spells the code `PS-01`; the chatbot use case and the document
 * number it specifies (`REQ-OSD-PS01-26090001`) both use `PS01`, and the number
 * is what people quote to each other. `PS01` wins.
 *
 * **No approval ladder.** The catalog marks this Pattern C — *"คำขอนี้ไม่มี
 * ชั้นอนุมัติ"*. That is configuration, not an omission: `complete` asks
 * `hasPublishedMatrix` first and, finding none, accepts the delivered result
 * and moves the request straight to `approved`. Publishing a matrix for
 * `request:PS01` would change that, so do not.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const COMPANY_CODE = 'OSD';
const CODE = 'PS01';
/** `BSC` — the owning department in the catalog's column D. */
const RECEIVER_UNIT_CODE = 'BSC';
/** The catalog's SLA column reads 5 days, counted in office hours (H8X5). */
const SLA_DAYS = 5;
const HOURS_PER_DAY = 24;

/**
 * The seven fields step 4 of the use case asks the chatbot to collect —
 * minus one.
 *
 * "ผู้รับปลายทาง" is **not** here. It is `Request.receiverUserId`, a column the
 * ticket model already owns and that `assertReceivable` checks at submit.
 * Repeating it in the form would give a request two receivers that could
 * disagree, and only one of them would route anything.
 *
 * `x-order` carries the order because `formSchema` is stored as `jsonb`, which
 * does not preserve key order — Postgres returns keys sorted by length then
 * bytes. Authoring order here would otherwise reach the chatbot scrambled.
 */
const FORM_SCHEMA = {
  type: 'object',
  required: [
    'subject',
    'requester_department',
    'objective',
    'customer_project',
    'urgency',
    'needed_by',
  ],
  properties: {
    subject: { type: 'string', title: 'เรื่องที่ขอ', maxLength: 200, 'x-order': 10 },
    requester_department: {
      type: 'string',
      title: 'แผนกผู้ขอ',
      maxLength: 120,
      'x-order': 20,
    },
    objective: {
      type: 'string',
      title: 'วัตถุประสงค์',
      maxLength: 2000,
      'x-multiline': true,
      'x-order': 30,
    },
    customer_project: {
      type: 'string',
      title: 'ลูกค้า / โครงการ',
      maxLength: 200,
      'x-order': 40,
    },
    urgency: {
      type: 'string',
      title: 'ความเร่งด่วน',
      enum: ['ปกติ', 'เร่งด่วน', 'เร่งด่วนมาก'],
      'x-order': 50,
    },
    needed_by: {
      type: 'string',
      format: 'date',
      title: 'วันที่ต้องการได้รับ',
      'x-order': 60,
    },
  },
};

/**
 * What Pre-Sales fills in when they finish — step 9's "ความเห็น/บันทึก" and
 * "หมายเหตุ เพิ่มเติม".
 *
 * A second schema rather than optional fields on the first: the requester
 * never sees these, and `assertReceiverFormComplete` enforces them at
 * `complete` rather than at submit.
 */
const RECEIVER_FORM_SCHEMA = {
  type: 'object',
  required: ['note'],
  properties: {
    note: {
      type: 'string',
      title: 'ความเห็น / บันทึก',
      maxLength: 2000,
      'x-multiline': true,
      'x-order': 10,
    },
    remark: {
      type: 'string',
      title: 'หมายเหตุเพิ่มเติม',
      maxLength: 2000,
      'x-multiline': true,
      'x-order': 20,
    },
  },
};

/** Offered by the API when the receiver sends a request back (REQ-04). */
const RETURN_REASON_CODES = [
  { code: 'INFO_INCOMPLETE', name: 'ข้อมูลไม่ครบ' },
  { code: 'OUT_OF_SCOPE', name: 'ไม่อยู่ในขอบเขตงาน Pre-Sales' },
  { code: 'DATE_UNREALISTIC', name: 'วันที่ต้องการได้รับเร็วเกินไป' },
  { code: 'OTHER', name: 'อื่น ๆ (ระบุ)' },
];

async function seedPresalesType(): Promise<void> {
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
    A missing receiving team is reported, not fatal. The type is still usable —
    the requester names a receiver on every request anyway — and refusing to
    seed would make this script depend on the org chart having been imported
    first, which is a different job.
  */
  if (!receiverUnit) {
    console.warn(
      `  warning: no org unit "${RECEIVER_UNIT_CODE}" in ${COMPANY_CODE};` +
        ' the type is seeded with no default receiving team.',
    );
  }

  const data = {
    name: 'ขอ Pre-Sales / Solution Design',
    receiverOrgUnitId: receiverUnit?.id ?? null,
    formSchema: FORM_SCHEMA,
    receiverFormSchema: RECEIVER_FORM_SCHEMA,
    requiredDocs: [],
    returnReasonCodes: RETURN_REASON_CODES,
    // Pattern C. Left empty rather than naming a chain that does not exist —
    // `approvalPolicy` is vestigial now that routing lives on the matrix.
    approvalPolicy: {},
    slaHours: SLA_DAYS * HOURS_PER_DAY,
    slaCoverage: 'H8X5' as const,
    active: true,
  };

  const saved = await prisma.requestType.upsert({
    where: { code: CODE },
    update: { ...data, updatedBy: 'presales-seed' },
    create: { code: CODE, ...data, createdBy: 'presales-seed' },
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

  console.log(`  ${CODE} · ${data.name}`);
  console.log(`  company: ${COMPANY_CODE}`);
  console.log(
    `  receiving team: ${receiverUnit ? receiverUnit.name : '(none)'}`,
  );
  console.log(`  SLA: ${SLA_DAYS} วัน (H8X5) · no approval ladder`);
}

seedPresalesType()
  .then(() => console.log('Done.'))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
