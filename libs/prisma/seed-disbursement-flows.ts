/**
 * Puts FI05 / FI06 on their flow-v2 tickets and maps the work steps for the
 * disbursement screen. `yarn disbursement-flow:seed` — idempotent; run after
 * `petty:seed` and `petty-claim:seed`. docs/disbursement.md §3
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { disbursementFlow, WORK_STEPS } from './disbursement-flows';

const prisma = new PrismaClient();

const COMPANY_CODE = 'OSD';
const FINANCE_UNIT_CODE = 'FAC';
const SEEDED_BY = 'disbursement-flow-seed';
const TYPES = [
  { code: 'FI05', kind: 'ADVANCE' as const },
  { code: 'FI06', kind: 'PETTY_CASH' as const },
];

type Flow = ReturnType<typeof disbursementFlow>;
type StepRow = Omit<Prisma.RequestFlowStepCreateManyInput, 'flowVersionId'>;
type TransitionRow = Omit<
  Prisma.RequestFlowTransitionCreateManyInput,
  'flowVersionId'
>;

async function seedDisbursementFlows(): Promise<void> {
  const company = await prisma.company.findUnique({
    where: { code: COMPANY_CODE },
  });
  if (!company) throw new Error(`No company "${COMPANY_CODE}".`);

  // `code` or `name`: the two org-chart sources disagree (see seed-petty-cash-type.ts).
  const finance = await prisma.orgUnit.findFirst({
    where: {
      companyId: company.id,
      OR: [{ code: FINANCE_UNIT_CODE }, { name: FINANCE_UNIT_CODE }],
    },
  });
  if (!finance) {
    throw new Error(
      `No org unit "${FINANCE_UNIT_CODE}" in ${COMPANY_CODE}: the executive step needs one.`,
    );
  }

  for (const { code, kind } of TYPES) {
    const type = await prisma.requestType.findUnique({ where: { code } });
    if (!type) throw new Error(`No request type ${code}. Run its seed first.`);
    const flow = disbursementFlow(kind, type.formSchema, finance.id);
    console.log(`  ${code}: ${await publishFlow(flow, type.id, company.id)}`);
  }

  await prisma.disbursementSettings.upsert({
    where: { companyId: company.id },
    update: { ...WORK_STEPS, updatedBy: SEEDED_BY },
    create: {
      companyId: company.id,
      advanceTypeCode: 'FI05',
      pettyCashTypeCode: 'FI06',
      ...WORK_STEPS,
      updatedBy: SEEDED_BY,
    },
  });
  console.log(`  work steps: ${Object.values(WORK_STEPS).join(' · ')}`);
  console.log(`  executive step: head of ${finance.name} (proposed — edit in the flow builder)`);
}

/** The columns `RequestFlowAdminService.publish` writes for a v2 step. */
function stepRows(flow: Flow): StepRow[] {
  return flow.steps.map((step, index) => ({
    code: step.code,
    name: step.name,
    sortOrder: index + 1,
    formSchema:
      'form_schema' in step && step.form_schema
        ? (step.form_schema as Prisma.InputJsonValue)
        : Prisma.DbNull,
    subRequestTypes: [],
    requiresApproval: false,
    assigneeRule: Prisma.DbNull,
    slaHours: null,
    scopeStatus: step.scope_status,
    receiverRule: Prisma.DbNull,
    returnToStepCode: 'return_to_step' in step ? step.return_to_step : null,
    approvalLevels:
      'approval_levels' in step ? step.approval_levels : Prisma.DbNull,
    requiredDocs: [],
  }));
}

/** Sort order counts per source step and direction, as the admin publish does. */
function transitionRows(flow: Flow): TransitionRow[] {
  const counters = new Map<string, number>();
  return flow.transitions.map((exit) => {
    const backward = 'backward' in exit ? exit.backward : false;
    const key = `${exit.from_step}:${backward ? 'b' : 'f'}`;
    const sortOrder = (counters.get(key) ?? 0) + 1;
    counters.set(key, sortOrder);
    return {
      fromStepCode: exit.from_step,
      toStepCode: exit.to_step,
      sortOrder,
      condition: Prisma.DbNull,
      backward,
    };
  });
}

/** Writes version N+1 only when the latest differs; requests in flight keep theirs. */
async function publishFlow(
  flow: Flow,
  requestTypeId: string,
  companyId: string,
): Promise<string> {
  const steps = stepRows(flow);
  const transitions = transitionRows(flow);
  const latest = await prisma.requestFlowVersion.findFirst({
    where: { companyId, requestTypeId },
    orderBy: { version: 'desc' },
    include: { steps: { orderBy: { sortOrder: 'asc' } }, transitions: true },
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

/** JSONB reorders keys, so values are compared key-sorted. */
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

seedDisbursementFlows()
  .then(() => console.log('Done.'))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
