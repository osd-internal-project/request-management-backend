/**
 * Create the "D CALL" company from OSD: the same people with the same roles,
 * a copy of OSD's org chart, request type DC-RQ-001 copied from DCRQ001, OSD's
 * product catalog, and 5 mock customers + 5 mock projects.
 *
 *   DCALL_SEED_ALLOW=1 yarn dcall:seed
 *
 * Each person sits in D CALL's copy of their OSD unit (`user_companies.orgUnitId`
 * is per company) and keeps their place in OSD. Roles come
 * across as MANUAL grants (Keycloak is login only). `uat_superadmin` is not
 * copied — `yarn uat:seed` owns it (AGENTS.md). Idempotent — safe to re-run.
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { normalizeCustomerName } from '../../services/core-service/src/crm/customer-name';

const prisma = new PrismaClient();

const SOURCE = 'OSD';
const COMPANY = { code: 'DCALL', name: 'D CALL', docPrefix: 'DC', baseCurrency: 'THB' };
const SOURCE_TYPE = 'DCRQ001';
const TYPE = { code: 'DC-RQ-001', name: 'D Call คำขอทั่วไป' };
const SKIP_ROLES = ['uat_superadmin'];
const BY = 'seed-dcall-company';
const MOCK = 'mock-dcall-';

const CUSTOMERS = [
  { nameTh: 'บริษัท ดีคอล เทคโนโลยี จำกัด', nameEn: 'D Call Technology Co., Ltd.', type: 'corporate' },
  { nameTh: 'บริษัท สยามคอนแทค เซ็นเตอร์ จำกัด', nameEn: 'Siam Contact Center Co., Ltd.', type: 'corporate' },
  { nameTh: 'บริษัท ไทยเน็ตเวิร์ค โซลูชั่น จำกัด', nameEn: 'Thai Network Solution Co., Ltd.', type: 'corporate' },
  { nameTh: 'การไฟฟ้าส่วนภูมิภาค (ตัวอย่าง)', nameEn: 'PEA (mock)', type: 'government' },
  { nameTh: 'คุณสมศรี ใจงาม', nameEn: 'Somsri Jaingam', type: 'individual' },
] as const;

const PROJECTS = [
  'ติดตั้งระบบ Call Center 50 ที่นั่ง',
  'ย้ายระบบ IVR ขึ้น Cloud',
  'บำรุงรักษาระบบโทรศัพท์ประจำปี',
  'เชื่อมต่อ CRM กับระบบ Call Center',
  'อบรมพนักงาน Contact Center',
];

function assertAllowed(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed D CALL with NODE_ENV=production.');
  }
  if (process.env.DCALL_SEED_ALLOW !== '1') {
    throw new Error('Set DCALL_SEED_ALLOW=1 to confirm the target database.');
  }
}

const day = (offset: number) => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset));
};

async function copyRoles(sourceId: string, companyId: string): Promise<Map<string, string>> {
  const roles = await prisma.role.findMany({
    where: { companyId: sourceId, code: { notIn: SKIP_ROLES } },
    include: { permissions: true, scopeRules: true },
  });
  const map = new Map<string, string>();
  for (const role of roles) {
    const data = {
      name: role.name,
      description: role.description,
      isSystem: role.isSystem,
      active: role.active,
      visibilityLevel: role.visibilityLevel,
      level: role.level,
    };
    const copy = await prisma.role.upsert({
      where: { companyId_code: { companyId, code: role.code } },
      update: data,
      create: { ...data, companyId, code: role.code, createdBy: BY },
    });
    map.set(role.id, copy.id);
    await prisma.rolePermission.createMany({
      data: role.permissions.map((p) => ({ roleId: copy.id, permissionCode: p.permissionCode })),
      skipDuplicates: true,
    });
    for (const rule of role.scopeRules) {
      await prisma.scopeRule.upsert({
        where: { roleId_resource: { roleId: copy.id, resource: rule.resource } },
        update: { scope: rule.scope },
        create: { roleId: copy.id, resource: rule.resource, scope: rule.scope },
      });
    }
  }
  return map;
}

/** Parents before children: a unit's depth is its longest path from a root. */
async function copyOrgChart(
  sourceId: string,
  companyId: string,
): Promise<{ rootId: string; units: number; unitMap: Map<string, string> }> {
  const units = await prisma.orgUnit.findMany({ where: { companyId: sourceId } });
  const ids = units.map((u) => u.id);
  const closure = await prisma.orgClosure.findMany({ where: { descendantId: { in: ids } } });
  const depth = new Map<string, number>();
  for (const row of closure) {
    depth.set(row.descendantId, Math.max(depth.get(row.descendantId) ?? 0, row.depth));
  }
  units.sort((a, b) => (depth.get(a.id) ?? 0) - (depth.get(b.id) ?? 0));

  const map = new Map<string, string>();
  let rootId: string | null = null;
  for (const unit of units) {
    const isRoot = unit.parentId === null && unit.kind === 'COMPANY';
    const code = isRoot ? COMPANY.code : unit.code;
    const data = {
      name: isRoot ? COMPANY.name : unit.name,
      kind: unit.kind,
      parentId: unit.parentId ? map.get(unit.parentId) ?? null : null,
      managerUserId: unit.managerUserId,
      active: unit.active,
    };
    const copy = await prisma.orgUnit.upsert({
      where: { companyId_code: { companyId, code } },
      update: data,
      create: { ...data, companyId, code, createdBy: BY },
    });
    map.set(unit.id, copy.id);
    if (isRoot && !rootId) rootId = copy.id;
  }
  if (!rootId) throw new Error(`${SOURCE} has no COMPANY root unit to copy.`);

  await prisma.orgClosure.createMany({
    data: closure.flatMap((row) => {
      const ancestorId = map.get(row.ancestorId);
      const descendantId = map.get(row.descendantId);
      return ancestorId && descendantId ? [{ ancestorId, descendantId, depth: row.depth }] : [];
    }),
    skipDuplicates: true,
  });
  return { rootId, units: map.size, unitMap: map };
}

async function copyPeople(
  sourceId: string,
  companyId: string,
  roles: Map<string, string>,
  unitMap: Map<string, string>,
) {
  const members = await prisma.userCompany.findMany({ where: { companyId: sourceId } });
  await prisma.userCompany.createMany({
    data: members.map((m) => ({ userId: m.userId, companyId, isPrimary: false })),
    skipDuplicates: true,
  });
  // Each person sits in D CALL's copy of their OSD unit; OSD's placement stays as it is.
  for (const m of members) {
    const orgUnitId = m.orgUnitId ? unitMap.get(m.orgUnitId) : undefined;
    if (!orgUnitId) continue;
    await prisma.userCompany.update({
      where: { userId_companyId: { userId: m.userId, companyId } },
      data: { orgUnitId },
    });
  }
  const grants = await prisma.userRole.findMany({ where: { companyId: sourceId } });
  await prisma.userRole.createMany({
    data: grants.flatMap((g) => {
      const roleId = roles.get(g.roleId);
      return roleId ? [{ userId: g.userId, roleId, companyId, source: 'MANUAL' as const }] : [];
    }),
    skipDuplicates: true,
  });
}

/** OSD's product catalog as D CALL's own rows (codes are unique per company). */
async function copyProducts(sourceId: string, companyId: string) {
  const products = await prisma.product.findMany({ where: { companyId: sourceId } });
  await prisma.product.createMany({
    data: products.map((p) => ({
      companyId,
      code: p.code,
      name: p.name,
      unit: p.unit,
      groupCode: p.groupCode,
      groupName: p.groupName,
      active: p.active,
      source: p.source,
      syncedAt: p.syncedAt,
    })),
    skipDuplicates: true,
  });
}

async function copyRequestType(companyId: string, receiverOrgUnitId: string) {
  const source = await prisma.requestType.findUnique({ where: { code: SOURCE_TYPE } });
  if (!source) throw new Error(`No request type ${SOURCE_TYPE} to copy.`);
  const data = {
    name: TYPE.name,
    receiverOrgUnitId,
    formSchema: source.formSchema as Prisma.InputJsonValue,
    receiverFormSchema: (source.receiverFormSchema ?? Prisma.DbNull) as Prisma.InputJsonValue,
    requiredDocs: source.requiredDocs as Prisma.InputJsonValue,
    returnReasonCodes: source.returnReasonCodes as Prisma.InputJsonValue,
    subRequestTypes: source.subRequestTypes as Prisma.InputJsonValue,
    approvalPolicy: source.approvalPolicy as Prisma.InputJsonValue,
    slaHours: source.slaHours,
    slaCoverage: source.slaCoverage,
    refRequired: source.refRequired,
    active: true,
    updatedBy: BY,
  };
  const type = await prisma.requestType.upsert({
    where: { code: TYPE.code },
    update: data,
    create: { ...data, code: TYPE.code, createdBy: BY },
  });
  await prisma.requestTypeCompany.upsert({
    where: { requestTypeId_companyId: { requestTypeId: type.id, companyId } },
    update: { active: true },
    create: { requestTypeId: type.id, companyId },
  });
}

async function seedMocks(companyId: string, ownerUserId: string) {
  for (const [i, c] of CUSTOMERS.entries()) {
    const n = String(i + 1).padStart(2, '0');
    const customerId = `${MOCK}cus-${n}`;
    await prisma.customer.upsert({
      where: { id: customerId },
      update: {},
      create: {
        id: customerId,
        customerCode: `CUS-DCALL-MOCK-${n}`,
        companyId,
        type: c.type,
        nameTh: c.nameTh,
        nameEn: c.nameEn,
        normalizedName: normalizeCustomerName(c.nameTh),
        status: 'active',
        accountOwnerUserId: ownerUserId,
        createdBy: BY,
      },
    });

    const contractId = `${MOCK}ctr-${n}`;
    const contractNo = `CTR-DCALL-MOCK-${n}`;
    const value = 100_000 * (i + 1);
    await prisma.customerContract.upsert({
      where: { id: contractId },
      update: {},
      create: {
        id: contractId,
        companyId,
        customerId,
        contractNo,
        title: `สัญญา${PROJECTS[i]}`,
        startOn: day(-30),
        endOn: day(335),
        value: new Prisma.Decimal(value),
        status: 'active',
        ownerUserId,
        signedOn: day(-37),
        signedVia: 'manual',
        signedRecordedBy: ownerUserId,
        createdBy: BY,
      },
    });

    await prisma.project.upsert({
      where: { id: `${MOCK}prj-${n}` },
      update: {},
      create: {
        id: `${MOCK}prj-${n}`,
        companyId,
        projectNo: `PRJ-DCALL-MOCK-${n}`,
        name: PROJECTS[i],
        contractId,
        customerId,
        managerUserId: ownerUserId,
        status: 'active',
        startOn: day(-30),
        endOn: day(150),
        contractValue: new Prisma.Decimal(value),
        baseline: {
          contract: { contractNo, title: `สัญญา${PROJECTS[i]}`, party: c.nameTh, value, currency: 'THB' },
          solution: { solutionId: null, title: PROJECTS[i], versionNo: 1 },
          scope: { inScope: [], outOfScope: [], deliverables: [], assumptions: [] },
          boq: [],
          labor: [],
          cost: null,
          installments: [],
          capturedAt: day(-30).toISOString(),
        },
        openedAt: day(-30),
        openedBy: ownerUserId,
        note: 'ข้อมูลตัวอย่าง (mock)',
      },
    });
  }
}

async function main(): Promise<void> {
  assertAllowed();
  const source = await prisma.company.findUnique({ where: { code: SOURCE } });
  if (!source) throw new Error(`No company "${SOURCE}" to copy from.`);

  const company = await prisma.company.upsert({
    where: { code: COMPANY.code },
    update: {},
    create: COMPANY,
  });
  const roles = await copyRoles(source.id, company.id);
  const { rootId, units, unitMap } = await copyOrgChart(source.id, company.id);
  await copyPeople(source.id, company.id, roles, unitMap);
  await copyProducts(source.id, company.id);
  await copyRequestType(company.id, rootId);

  // the copied root's manager owns the mocks; the chart is OSD's, so it has one
  const root = await prisma.orgUnit.findUniqueOrThrow({ where: { id: rootId } });
  if (!root.managerUserId) throw new Error(`${SOURCE}'s root unit has no manager to own the mocks.`);
  await seedMocks(company.id, root.managerUserId);

  const where = { companyId: company.id };
  const counts = {
    roles: await prisma.role.count({ where }),
    units,
    members: await prisma.userCompany.count({ where }),
    placed: await prisma.userCompany.count({ where: { ...where, orgUnitId: { not: null } } }),
    grants: await prisma.userRole.count({ where }),
    products: await prisma.product.count({ where }),
    customers: await prisma.customer.count({ where }),
    projects: await prisma.project.count({ where }),
  };
  console.log(`D CALL ${company.id}`, counts);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
