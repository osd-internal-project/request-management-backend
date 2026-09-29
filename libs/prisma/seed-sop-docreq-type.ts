/**
 * The `SOP_DOCREQ` request type — การขอใช้เอกสารสำคัญของบริษัท, run on flow v2.
 *
 *   yarn sop:seed
 *
 * Idempotent; safe to re-run. The form and flow live in `sop-docreq-flow.ts`
 * and are validated by `services/core-service/src/requests/sop-docreq-flow.spec.ts`,
 * because this script writes the flow rows directly instead of going through
 * `RequestFlowAdminService.publish`.
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { SOP_DOCREQ_FLOW, SOP_DOCREQ_FORM } from './sop-docreq-flow';

const prisma = new PrismaClient();

const COMPANY_CODE = 'OSD';
const CODE = 'SOP_DOCREQ';
const SEEDED_BY = 'sop-docreq-seed';
/** ผู้ดูแลเอกสาร; matched exactly against `users.email`. */
const RECEIVER_EMAIL = 'wasitteem@osd.co.th';
/** SOP: "แผนกที่ขอได้ FAC , LEG , PCD". */
const REQUESTER_UNIT_CODES = ['FAC', 'LEG', 'PCD'];
/** Not in the SOP; one working day to hand the documents over. */
const SLA_HOURS = 24;

const RETURN_REASON_CODES = [
  { code: 'PURPOSE_UNCLEAR', name: 'วัตถุประสงค์ไม่ชัดเจน / ไม่สมเหตุสมผล' },
  { code: 'INFO_INCOMPLETE', name: 'ข้อมูลไม่ครบ' },
  { code: 'DOC_NOT_ALLOWED', name: 'เอกสารนี้ไม่อนุญาตให้ขอ' },
  { code: 'OTHER', name: 'อื่น ๆ (ระบุ)' },
];

async function seedSopDocReqType(): Promise<void> {
  const company = await prisma.company.findUnique({
    where: { code: COMPANY_CODE },
  });
  if (!company) {
    throw new Error(
      `No company "${COMPANY_CODE}". Run \`yarn prisma:seed\` first.`,
    );
  }

  // Fatal, unlike a missing unit: without a receiver the RECEIVE step has nobody to hold it.
  const receiver = await prisma.user.findFirst({
    where: {
      email: RECEIVER_EMAIL,
      companies: { some: { companyId: company.id } },
    },
    select: { id: true },
  });
  if (!receiver) {
    throw new Error(
      `No user "${RECEIVER_EMAIL}" in ${COMPANY_CODE}; the type needs its receiver.`,
    );
  }

  const data = {
    name: 'ขอใช้เอกสารสำคัญของบริษัท (ภายในองค์กร)',
    receiverOrgUnitId: null,
    receiverUserId: receiver.id,
    formSchema: SOP_DOCREQ_FORM,
    receiverFormSchema: Prisma.DbNull,
    requiredDocs: [],
    returnReasonCodes: RETURN_REASON_CODES,
    // Vestigial since routing moved to the matrix; see `seed-presales-type.ts`.
    approvalPolicy: {},
    slaHours: SLA_HOURS,
    slaCoverage: 'H8X5' as const,
    active: true,
  };

  const saved = await prisma.requestType.upsert({
    where: { code: CODE },
    update: { ...data, updatedBy: SEEDED_BY },
    create: { code: CODE, ...data, createdBy: SEEDED_BY },
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

  const units = await restrictToRequesterUnits(saved.id, company.id);
  const flow = await publishFlow(saved.id, company.id);

  console.log(`  ${CODE} · ${data.name}`);
  console.log(`  company: ${COMPANY_CODE}`);
  console.log(`  receiver: ${RECEIVER_EMAIL}`);
  console.log(`  who may raise it: ${units.join(', ') || '(everyone)'}`);
  console.log(`  SLA: ${SLA_HOURS} ชม. (H8X5)`);
  console.log(`  flow: ${flow}`);
}

/**
 * Matched on `code` *or* `name`, for the same reason as `seed-petty-cash-type.ts`:
 * an imported chart keeps the abbreviation in `name`. Returns the units found.
 */
async function restrictToRequesterUnits(
  requestTypeId: string,
  companyId: string,
): Promise<string[]> {
  const found = await prisma.orgUnit.findMany({
    where: {
      companyId,
      OR: [
        { code: { in: REQUESTER_UNIT_CODES } },
        { name: { in: REQUESTER_UNIT_CODES } },
      ],
    },
    select: { id: true, code: true, name: true },
  });

  const labels = found.map((unit) =>
    REQUESTER_UNIT_CODES.includes(unit.code) ? unit.code : unit.name,
  );
  const missing = REQUESTER_UNIT_CODES.filter((code) => !labels.includes(code));
  if (missing.length) {
    console.warn(
      `  warning: no org unit ${missing.join(', ')} in ${COMPANY_CODE};` +
        ' those departments cannot raise the type.',
    );
  }

  // No rows means everybody may raise it, so an empty match must not wipe the restriction silently.
  if (!found.length) {
    throw new Error(
      'None of FAC, LEG, PCD found; refusing to open the type to everyone.',
    );
  }

  await prisma.$transaction([
    prisma.requestTypeOrgUnit.deleteMany({ where: { requestTypeId } }),
    prisma.requestTypeOrgUnit.createMany({
      data: found.map((unit) => ({ requestTypeId, orgUnitId: unit.id })),
    }),
  ]);
  return labels;
}

type StepRow = Omit<Prisma.RequestFlowStepCreateManyInput, 'flowVersionId'>;
type TransitionRow = Omit<
  Prisma.RequestFlowTransitionCreateManyInput,
  'flowVersionId'
>;

/** The columns `RequestFlowAdminService.publish` writes for a v2 step. */
function stepRows(): StepRow[] {
  return SOP_DOCREQ_FLOW.steps.map((step, index) => ({
    code: step.code,
    name: step.name,
    sortOrder: index + 1,
    formSchema: 'form_schema' in step ? step.form_schema : Prisma.DbNull,
    subRequestTypes: [],
    requiresApproval: false,
    assigneeRule: Prisma.DbNull,
    slaHours: 'sla_hours' in step ? step.sla_hours : null,
    scopeStatus: step.scope_status,
    receiverRule: Prisma.DbNull,
    returnToStepCode: 'return_to_step' in step ? step.return_to_step : null,
    approvalLevels:
      'approval_levels' in step ? step.approval_levels : Prisma.DbNull,
    requiredDocs: 'required_docs' in step ? step.required_docs : [],
  }));
}

/** Sort order counts per source step and direction, as the admin publish does. */
function transitionRows(): TransitionRow[] {
  const counters = new Map<string, number>();
  return SOP_DOCREQ_FLOW.transitions.map((exit) => {
    const backward = 'backward' in exit ? exit.backward : false;
    const key = `${exit.from_step}:${backward ? 'b' : 'f'}`;
    const sortOrder = (counters.get(key) ?? 0) + 1;
    counters.set(key, sortOrder);
    return {
      fromStepCode: exit.from_step,
      toStepCode: exit.to_step,
      sortOrder,
      condition: 'condition' in exit ? exit.condition : Prisma.DbNull,
      backward,
    };
  });
}

/**
 * Writes version N+1 only when the latest published version differs.
 * A published version is never edited: requests in flight are pinned to it.
 */
async function publishFlow(
  requestTypeId: string,
  companyId: string,
): Promise<string> {
  const steps = stepRows();
  const transitions = transitionRows();

  const latest = await prisma.requestFlowVersion.findFirst({
    where: { companyId, requestTypeId },
    orderBy: { version: 'desc' },
    include: {
      steps: { orderBy: { sortOrder: 'asc' } },
      transitions: true,
    },
  });

  if (
    latest?.schemaVersion === 2 &&
    sameRows(latest.steps, steps) &&
    sameRows(sortTransitions(latest.transitions), sortTransitions(transitions))
  ) {
    return `v${latest.version} unchanged, left alone`;
  }

  const created = await prisma.requestFlowVersion.create({
    data: {
      companyId,
      requestTypeId,
      version: (latest?.version ?? 0) + 1,
      schemaVersion: 2,
      publishedBy: SEEDED_BY,
      steps: { createMany: { data: steps } },
      transitions: { createMany: { data: transitions } },
    },
  });
  return `v${created.version} published (${steps.length} steps)`;
}

interface TransitionKey {
  readonly fromStepCode: string;
  readonly backward?: boolean;
  readonly sortOrder: number;
}

function sortTransitions<T extends TransitionKey>(rows: readonly T[]): T[] {
  const key = (row: T) =>
    `${row.fromStepCode}:${row.backward ? 1 : 0}:${row.sortOrder}`;
  return [...rows].sort((a, b) => key(a).localeCompare(key(b)));
}

/** Compares the columns we write; JSONB reorders keys, so values are compared key-sorted. */
function sameRows(
  stored: readonly Record<string, unknown>[],
  wanted: readonly Record<string, unknown>[],
): boolean {
  if (stored.length !== wanted.length) return false;
  return wanted.every((row, index) =>
    Object.entries(row).every(
      ([column, value]) =>
        stableJson(stored[index][column]) === stableJson(value),
    ),
  );
}

function stableJson(value: unknown): string {
  if (value === Prisma.DbNull || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, inner]) => `${JSON.stringify(key)}:${stableJson(inner)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

seedSopDocReqType()
  .then(() => console.log('Done.'))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
