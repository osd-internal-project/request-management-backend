/**
 * Create the "OSD (Lead)" company: a sales team that works leads only.
 *
 *   LEAD_COMPANY_ALLOW=1 yarn lead-company:seed
 *
 * Writes the company, a two-unit org tree (ROOT → SALES), the `sales_lead`
 * role and the Vuvagent connections for `lead.find` / `lead.research`,
 * copied from `OSD_DEMO` row for row — the sealed secret is copied as
 * stored, so it never passes through this script or its output.
 *
 * Idempotent — safe to re-run. People are added afterwards with `yarn user:add`.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const COMPANY = {
  code: 'OSD_LEAD',
  name: 'OSD (Lead)',
  docPrefix: 'OSDL',
  baseCurrency: 'THB',
};
const SOURCE_COMPANY = 'OSD_DEMO';
const AGENT_ACTIONS = ['lead.find', 'lead.research'];

/** Must match `sales_lead` in `seed.ts`. */
const ROLE = {
  code: 'sales_lead',
  name: 'ฝ่ายขาย (Lead)',
  description: 'ดูแล Lead บริษัทเป้าหมาย และสั่งงาน AI agent ของ Lead',
  permissions: ['notification.read', 'crm.lead.read', 'crm.lead.manage'],
};

async function upsertUnit(
  companyId: string,
  code: string,
  name: string,
  kind: 'COMPANY' | 'DEPARTMENT',
  parentId: string | null,
) {
  const unit = await prisma.orgUnit.upsert({
    where: { companyId_code: { companyId, code } },
    update: { name, kind, parentId },
    create: { companyId, code, name, kind, parentId },
  });

  const closure = [{ ancestorId: unit.id, descendantId: unit.id, depth: 0 }];
  if (parentId) closure.push({ ancestorId: parentId, descendantId: unit.id, depth: 1 });
  await prisma.orgClosure.createMany({ data: closure, skipDuplicates: true });

  return unit;
}

async function copyAgentConnections(companyId: string): Promise<number> {
  const source = await prisma.company.findUnique({ where: { code: SOURCE_COMPANY } });
  if (!source) throw new Error(`No company "${SOURCE_COMPANY}" to copy the agent from.`);

  const rows = await prisma.outboundConnection.findMany({
    where: { companyId: source.id, action: { in: AGENT_ACTIONS }, active: true },
    include: { integration: true },
  });
  if (!rows.length) throw new Error(`${SOURCE_COMPANY} has no active agent connection to copy.`);

  // a connection's secret belongs to one company, so its integration row does too
  const template = rows[0].integration;
  const integration =
    (await prisma.integration.findFirst({
      where: { companyId, name: template.name },
    })) ??
    (await prisma.integration.create({
      data: {
        companyId,
        name: template.name,
        description: template.description,
        modes: template.modes,
        allowActingUser: template.allowActingUser,
        createdBy: 'seed-lead-company',
      },
    }));

  for (const row of rows) {
    const data = {
      integrationId: integration.id,
      vendor: row.vendor,
      baseUrl: row.baseUrl,
      secretEnc: row.secretEnc,
      endpointId: row.endpointId,
      timeoutMinutes: row.timeoutMinutes,
      endpoints: row.endpoints ?? {},
      active: true,
    };
    await prisma.outboundConnection.upsert({
      where: { companyId_action: { companyId, action: row.action as string } },
      update: data,
      create: { ...data, companyId, action: row.action, createdBy: 'seed-lead-company' },
    });
  }

  return rows.length;
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to run under NODE_ENV=production.');
  }
  if (process.env.LEAD_COMPANY_ALLOW !== '1') {
    throw new Error('Refusing to run without LEAD_COMPANY_ALLOW=1.');
  }

  const company = await prisma.company.upsert({
    where: { code: COMPANY.code },
    update: COMPANY,
    create: COMPANY,
  });

  const root = await upsertUnit(company.id, 'ROOT', COMPANY.name, 'COMPANY', null);
  await upsertUnit(company.id, 'SALES', 'ฝ่ายขาย', 'DEPARTMENT', root.id);

  const role = await prisma.role.upsert({
    where: { companyId_code: { companyId: company.id, code: ROLE.code } },
    update: { name: ROLE.name, description: ROLE.description, isSystem: true },
    create: {
      companyId: company.id,
      code: ROLE.code,
      name: ROLE.name,
      description: ROLE.description,
      isSystem: true,
    },
  });
  await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
  await prisma.rolePermission.createMany({
    data: ROLE.permissions.map((permissionCode) => ({ roleId: role.id, permissionCode })),
  });

  const connections = await copyAgentConnections(company.id);

  console.log(`  company:     ${company.code} (${company.id})`);
  console.log('  org units:   ROOT → SALES');
  console.log(`  role:        ${ROLE.code} — ${ROLE.permissions.join(', ')}`);
  console.log(`  connections: ${connections} copied from ${SOURCE_COMPANY}`);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
