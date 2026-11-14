/**
 * The `CALL_LOG` request type — one per answered inbound softphone call.
 *
 *   yarn call-log:seed
 *
 * Idempotent; safe to re-run. Written as a draft by `POST softphone/call-logs`
 * after hang-up, with the agent as requester; the agent adds the topic and
 * notes. No approval ladder and no SLA: it records a call, it asks for nothing.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const COMPANY_CODE = process.env.CALL_LOG_COMPANY ?? 'OSD';
const CODE = 'CALL_LOG';

/** `x-order` because `jsonb` does not keep key order (see seed-presales-type). */
const FORM_SCHEMA = {
  type: 'object',
  required: ['phone'],
  properties: {
    phone: { type: 'string', title: 'เบอร์ผู้โทร', maxLength: 50, 'x-order': 10 },
    contact_name: {
      type: 'string',
      title: 'ชื่อผู้ติดต่อ',
      maxLength: 200,
      'x-order': 20,
    },
    topic: { type: 'string', title: 'เรื่อง', maxLength: 200, 'x-order': 30 },
    note: {
      type: 'string',
      title: 'บันทึกการสนทนา',
      maxLength: 4000,
      'x-multiline': true,
      'x-order': 40,
    },
    answered_at: {
      type: 'string',
      format: 'date-time',
      title: 'เวลารับสาย',
      'x-order': 50,
    },
    ended_at: {
      type: 'string',
      format: 'date-time',
      title: 'เวลาวางสาย',
      'x-order': 60,
    },
    duration_sec: {
      type: 'integer',
      title: 'ระยะเวลาคุย (วินาที)',
      minimum: 0,
      'x-order': 70,
    },
    call_id: { type: 'string', title: 'รหัสสาย', maxLength: 100, 'x-order': 80 },
  },
};

async function seedCallLogType(): Promise<void> {
  const company = await prisma.company.findUnique({
    where: { code: COMPANY_CODE },
  });
  if (!company) {
    throw new Error(`No company "${COMPANY_CODE}".`);
  }

  const existing = await prisma.requestType.findUnique({
    where: { code: CODE },
    select: { id: true, name: true, active: true, updatedAt: true },
  });
  console.log(
    existing
      ? `  existing ${CODE}: "${existing.name}" active=${existing.active} (updated ${existing.updatedAt.toISOString()}) — updating`
      : `  no ${CODE} yet — creating`,
  );

  const data = {
    name: 'บันทึกสายโทรเข้า (Call log)',
    receiverOrgUnitId: null,
    formSchema: FORM_SCHEMA,
    requiredDocs: [],
    returnReasonCodes: [],
    approvalPolicy: {},
    slaHours: null,
    active: true,
  };

  const saved = await prisma.requestType.upsert({
    where: { code: CODE },
    update: { ...data, updatedBy: 'call-log-seed' },
    create: { code: CODE, ...data, createdBy: 'call-log-seed' },
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
  console.log('  no approval ladder · no SLA');
}

seedCallLogType()
  .then(() => console.log('Done.'))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
