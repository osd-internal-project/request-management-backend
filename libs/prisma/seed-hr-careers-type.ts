/**
 * The `HR-S-001` request type — HR Request Careers (ประกาศรับสมัครงาน).
 *
 *   yarn hr-careers:seed
 *
 * Idempotent; safe to re-run. Built on `seed-presales-type.ts`.
 *
 * HRD raises it with the posting's text; อรสา (orasak@osd.co.th) receives it,
 * finishes it, and approves it on the after-work ladder `request:HR-S-001`.
 * `HR_CAREERS`, created on screen A2 on 12 Nov 2026 when the hyphen was
 * refused, is left inactive and untouched (user decision).
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const COMPANY_CODE = 'OSD';
const CODE = 'HR-S-001';
const REQUESTER_UNIT_CODE = 'OSD-OU0012'; // HRD · Human Resource
const APPROVER_UNIT_CODE = 'OSD-OU0009'; // Executive, อรสา's unit
const RECEIVER_EMAIL = 'orasak@osd.co.th';
const MATRIX_SUBJECT = `request:${CODE}`;
const SEED_BY = 'hr-careers-seed';

const text = (title: string, maxLength: number, order: number) => ({
  type: 'string',
  title,
  maxLength,
  'x-order': order,
});
const multiline = (title: string, maxLength: number, order: number) => ({
  ...text(title, maxLength, order),
  'x-multiline': true,
});

/** Flat `_th` / `_en` keys: the A2 form editor has no nested objects. */
const FORM_SCHEMA = {
  type: 'object',
  required: [
    'label_th',
    'label_en',
    'title_th',
    'title_en',
    'body_th',
    'body_en',
    'footnote_th',
    'footnote_en',
    'details_th',
  ],
  properties: {
    label_th: text('หมวดงาน (TH)', 100, 10),
    label_en: text('หมวดงาน (EN)', 100, 20),
    title_th: text('ชื่อตำแหน่ง (TH)', 200, 30),
    title_en: text('ชื่อตำแหน่ง (EN)', 200, 40),
    body_th: multiline('คำอธิบายสั้น (TH)', 1000, 50),
    body_en: multiline('คำอธิบายสั้น (EN)', 1000, 60),
    footnote_th: text('ประเภทงาน · สถานที่ (TH)', 200, 70),
    footnote_en: text('ประเภทงาน · สถานที่ (EN)', 200, 80),
    details_th: multiline('รายละเอียด (Markdown)', 5000, 90),
  },
};

const RECEIVER_FORM_SCHEMA = {
  type: 'object',
  required: [],
  properties: { note: multiline('ความเห็น', 2000, 10) },
};

const RETURN_REASON_CODES = [
  { code: 'INFO_INCOMPLETE', name: 'ข้อมูลไม่ครบ' },
  { code: 'OTHER', name: 'อื่น ๆ (ระบุ)' },
];

async function required<T>(what: string, row: Promise<T | null>): Promise<T> {
  const found = await row;
  if (!found) throw new Error(`Not found: ${what}`);
  return found;
}

async function seedHrCareersType(): Promise<void> {
  const company = await required(
    `company ${COMPANY_CODE}`,
    prisma.company.findUnique({ where: { code: COMPANY_CODE } }),
  );
  const unitByCode = (code: string) =>
    required(
      `org unit ${code}`,
      prisma.orgUnit.findFirst({ where: { companyId: company.id, code } }),
    );
  const requesterUnit = await unitByCode(REQUESTER_UNIT_CODE);
  const approverUnit = await unitByCode(APPROVER_UNIT_CODE);
  const receiver = await required(
    `user ${RECEIVER_EMAIL}`,
    prisma.user.findFirst({ where: { email: RECEIVER_EMAIL } }),
  );

  // The shape `assertOrgLevel` (matrix-rules.ts) accepts: units non-empty, user ids strings.
  const levels = [
    { type: 'org', orgUnitIds: [approverUnit.id], userIds: [receiver.id] },
  ];

  const data = {
    name: 'HR Request Careers',
    receiverOrgUnitId: null,
    receiverUserId: receiver.id,
    formSchema: FORM_SCHEMA,
    receiverFormSchema: RECEIVER_FORM_SCHEMA,
    requiredDocs: [],
    returnReasonCodes: RETURN_REASON_CODES,
    approvalPolicy: {}, // vestigial; routing lives on the matrix
    slaHours: null,
    slaCoverage: 'H8X5' as const,
    active: true,
  };

  const saved = await prisma.requestType.upsert({
    where: { code: CODE },
    update: { ...data, updatedBy: SEED_BY },
    create: { code: CODE, ...data, createdBy: SEED_BY },
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

  // Only HRD may raise it: one row restricts the type to that unit.
  await prisma.$transaction([
    prisma.requestTypeOrgUnit.deleteMany({ where: { requestTypeId: saved.id } }),
    prisma.requestTypeOrgUnit.create({
      data: { requestTypeId: saved.id, orgUnitId: requesterUnit.id },
    }),
  ]);

  const matrix = await publishMatrix(company.id, levels);

  console.log(`  ${CODE} · ${data.name} (company ${COMPANY_CODE})`);
  console.log(`  who may raise it: ${requesterUnit.name}`);
  console.log(`  receiver: ${receiver.displayName} <${RECEIVER_EMAIL}>`);
  console.log(`  approval: ${matrix}`);
}

/** Published matrices are immutable (§8): an existing one is left alone. */
async function publishMatrix(
  companyId: string,
  levels: { type: string; orgUnitIds: string[]; userIds: string[] }[],
): Promise<string> {
  const existing = await prisma.approvalMatrix.findFirst({
    where: { companyId, subjectType: MATRIX_SUBJECT },
  });
  if (existing) {
    return `${MATRIX_SUBJECT} v${existing.version} already published, left alone`;
  }

  const now = new Date();
  await prisma.approvalMatrix.create({
    data: {
      companyId,
      subjectType: MATRIX_SUBJECT,
      currency: 'THB',
      version: 1,
      effectiveFrom: now,
      publishedAt: now,
      levels,
      // NOT NULL and read by nothing; see the note on `ApprovalMatrix.tiers`.
      tiers: [{ upto: null, chain: ['org'] }],
      createdBy: SEED_BY,
    },
  });
  return `${MATRIX_SUBJECT} v1 · อรสา (หลังทำงาน)`;
}

seedHrCareersType()
  .then(() => console.log('Done.'))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
