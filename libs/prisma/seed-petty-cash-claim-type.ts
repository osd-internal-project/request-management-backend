/**
 * `FI06` ขอเบิกเงินสดย่อย, and the company's disbursement settings (FI05 → ADVANCE,
 * FI06 → PETTY_CASH). `yarn petty-claim:seed` — idempotent. docs/disbursement.md
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const COMPANY_CODE = 'OSD';
const CODE = 'FI06';
const ADVANCE_CODE = 'FI05';
const RECEIVER_UNIT_CODE = 'FAC';
const SLA_HOURS = 2 * 24;
const MATRIX_SUBJECT = `request:${CODE}:pre`;

// The money was already spent: every row is a receipt, and accounting pays it back.
const FORM_SCHEMA = {
  type: 'object',
  required: ['cost_center', 'purpose', 'expense_items'],
  properties: {
    cost_center: {
      type: 'string',
      title: 'Cost Center',
      maxLength: 60,
      'x-order': 20,
    },
    purpose: {
      type: 'string',
      title: 'วัตถุประสงค์',
      maxLength: 2000,
      'x-multiline': true,
      'x-order': 30,
    },
    remark: {
      type: 'string',
      title: 'หมายเหตุ',
      maxLength: 2000,
      'x-multiline': true,
      'x-order': 40,
    },
    expense_items: {
      type: 'array',
      title: 'รายการค่าใช้จ่าย (ตามใบเสร็จ)',
      maxItems: 20,
      'x-order': 50,
      items: {
        type: 'object',
        required: ['receipt_date', 'description', 'amount'],
        properties: {
          receipt_date: {
            type: 'string',
            format: 'date',
            title: 'วันที่ใบเสร็จ',
            'x-order': 10,
          },
          description: {
            type: 'string',
            title: 'รายการค่าใช้จ่าย',
            maxLength: 200,
            'x-order': 20,
          },
          cost_center: {
            type: 'string',
            title: 'Cost Center',
            maxLength: 60,
            'x-order': 30,
          },
          amount: { type: 'number', title: 'จำนวนเงิน (บาท)', 'x-order': 40 },
          note: {
            type: 'string',
            title: 'หมายเหตุ',
            maxLength: 200,
            'x-order': 50,
          },
        },
      },
    },
  },
};

// Same keys as FI05's, because `close`/`pay` hand the accountant's checks to `complete`.
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
      title: 'ตรวจสอบใบเสร็จครบถ้วนถูกต้อง',
      'x-order': 20,
    },
    checked_authority: {
      type: 'boolean',
      title: 'ยอดเบิกตรงตามระดับอำนาจอนุมัติ',
      'x-order': 30,
    },
    note: {
      type: 'string',
      title: 'ความเห็นของผู้ตรวจ',
      maxLength: 2000,
      'x-multiline': true,
      'x-order': 40,
    },
  },
};

const RETURN_REASON_CODES = [
  { code: 'RECEIPT_MISSING', name: 'ใบเสร็จไม่ครบ/ไม่ชัด' },
  { code: 'OVER_LIMIT', name: 'เกินวงเงินที่เบิกได้' },
  { code: 'COST_CENTER_INVALID', name: 'Cost Center ไม่ถูกต้อง' },
  { code: 'OTHER', name: 'อื่น ๆ (ระบุ)' },
];

async function seedPettyCashClaimType(): Promise<void> {
  const company = await prisma.company.findUnique({
    where: { code: COMPANY_CODE },
  });
  if (!company) {
    throw new Error(`No company "${COMPANY_CODE}". Run \`yarn prisma:seed\` first.`);
  }

  // `code` or `name`: the two org-chart sources disagree (see seed-petty-cash-type.ts).
  const receiverUnit = await prisma.orgUnit.findFirst({
    where: {
      companyId: company.id,
      OR: [{ code: RECEIVER_UNIT_CODE }, { name: RECEIVER_UNIT_CODE }],
    },
  });
  if (!receiverUnit) {
    console.warn(
      `  warning: no org unit "${RECEIVER_UNIT_CODE}" in ${COMPANY_CODE}; seeded with no default receiving team.`,
    );
  }

  const data = {
    name: 'ขอเบิกเงินสดย่อย (Petty Cash)',
    receiverOrgUnitId: receiverUnit?.id ?? null,
    formSchema: FORM_SCHEMA,
    receiverFormSchema: RECEIVER_FORM_SCHEMA,
    // Receipts are attached on the request, but the external API cannot attach files.
    requiredDocs: [],
    returnReasonCodes: RETURN_REASON_CODES,
    approvalPolicy: {},
    slaHours: SLA_HOURS,
    slaCoverage: 'H8X5' as const,
    active: true,
  };

  const saved = await prisma.requestType.upsert({
    where: { code: CODE },
    update: { ...data, updatedBy: 'petty-claim-seed' },
    create: { code: CODE, ...data, createdBy: 'petty-claim-seed' },
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
  // No org-unit rows: anybody may claim petty cash.
  await prisma.requestTypeOrgUnit.deleteMany({
    where: { requestTypeId: saved.id },
  });

  await prisma.disbursementSettings.upsert({
    where: { companyId: company.id },
    update: {
      advanceTypeCode: ADVANCE_CODE,
      pettyCashTypeCode: CODE,
      updatedBy: 'petty-claim-seed',
    },
    create: {
      companyId: company.id,
      advanceTypeCode: ADVANCE_CODE,
      pettyCashTypeCode: CODE,
      updatedBy: 'petty-claim-seed',
    },
  });

  const matrix = await publishPreApprovalMatrix(company.id);

  console.log(`  ${CODE} · ${data.name}`);
  console.log(`  receiving team: ${receiverUnit ? receiverUnit.name : '(none)'}`);
  console.log(`  disbursement: ${ADVANCE_CODE} → ADVANCE, ${CODE} → PETTY_CASH`);
  console.log(`  approval: ${matrix}`);
}

/** The requester's head, before the work; left alone once published (immutable, §8). */
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
      levels: [{ type: 'supervisor', up: 1 }],
      tiers: [{ upto: null, chain: ['department_manager'] }],
      createdBy: 'petty-claim-seed',
    },
  });
  return `${MATRIX_SUBJECT} v1 · หัวหน้าผู้ขอ (ก่อนเริ่มงาน)`;
}

seedPettyCashClaimType()
  .then(() => console.log('Done.'))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
